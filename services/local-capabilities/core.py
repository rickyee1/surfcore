"""Local authority: trusted stdio bindings, audience-first retrieval and durable budgets.

Adapted domain concepts from Luyao; see provenance.json. No LLM or network calls.
"""
import hashlib
import json
import re
import time
import uuid
from datetime import datetime, timedelta, timezone
from storage import Store, ServiceError, recover_reservations


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def text(value, maximum=1000):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ServiceError("INVALID_REQUEST", "字段必须为有界非空字符串。")
    return value


def integer(value, low, high):
    if type(value) is not int or not low <= value <= high:
        raise ServiceError("INVALID_REQUEST", "整数字段超出允许范围。")
    return value


def string_list(value):
    if not isinstance(value, list) or len(value) > 50:
        raise ServiceError("INVALID_REQUEST", "列表最多包含 50 条。")
    return [text(item, 1000) for item in value]


DEFAULT_ATTENTION = dict(enabled=False, daily_limit=3, cooldown_seconds=1200,
                         quiet_start="", quiet_end="", timezone="Asia/Shanghai", muted=False, focused=False)


class CapabilityService:
    def __init__(self, directory, clock=time.time):
        self.store = Store(directory)
        self.db = self.store.conn
        self.clock = clock
        self.active = {}
        self.bindings = {}
        self.after_commit = []
        try:
            from memory_governance import MemoryGovernance
            self.governance = MemoryGovernance(self)
            from backup import BackupManager
            self.backups = BackupManager(self)
            from tool_broker import ToolBroker
            self.tools = ToolBroker(self)
            # A manually restored older main file must still obey the independent ledger.
            self.db.execute('BEGIN IMMEDIATE')
            victims = self.db.execute('SELECT DISTINCT f.character,f.memory FROM fingerprints f JOIN sovereignty.tombstones t ON t.character=f.character AND t.kind=f.kind AND t.digest=f.digest JOIN memories m ON m.id=f.memory WHERE m.status!=?', ('deleted',)).fetchall()
            for victim in victims:
                self.delete_tree(victim['character'], victim['memory'])
                self.bump(victim['character'])
            self.db.execute('COMMIT')
        except Exception as error:
            if self.db.in_transaction:
                self.db.execute('ROLLBACK')
            self.close()
            if isinstance(error, ServiceError):
                raise
            raise ServiceError('SERVICE_UNAVAILABLE','记忆治理初始化失败。','保留数据和删除记录，检查版本与磁盘状态后重试。') from None

    def close(self):
        try:
            if self.store.conn is not None and hasattr(self, 'tools'):
                self.tools.close()
        finally:
            self.store.close()

    def poll(self):
        """Broker latches persistence faults before either request/idle polling returns."""
        self.tools.poll()

    def handle(self, request):
        request_id = request.get("request_id") if isinstance(request, dict) else None
        response = dict(protocol_version=1, request_id=request_id)
        try:
            self.poll()
            if not isinstance(request, dict):
                raise ServiceError("INVALID_REQUEST", "请求必须是 JSON 对象。")
            if request.get("protocol_version") != 1:
                raise ServiceError("PROTOCOL_MISMATCH", "能力协议版本不匹配。", "升级宿主与服务至相同协议版本。")
            text(request_id, 200)
            deadline = request.get("deadline")
            if deadline is not None and (type(deadline) not in (int, float) or not 0 < deadline < 1e16):
                raise ServiceError("INVALID_REQUEST", "截止时间必须是 Unix 毫秒。")
            if request.get("cancelled") is True or (deadline is not None and deadline <= self.clock() * 1000):
                raise ServiceError("REQUEST_CANCELLED", "请求已取消或超时。", "重新生成当前请求，不要重放旧发送任务。")
            op = text(request.get("op"), 80)
            params = request.get("params", {})
            if not isinstance(params, dict):
                raise ServiceError("INVALID_REQUEST", "params 必须是对象。")
            self.after_commit = []
            self.db.execute("BEGIN IMMEDIATE")
            try:
                result = self.dispatch(op, request, params)
                self.db.execute("COMMIT")
                for callback in self.after_commit:
                    callback()
            except BaseException:
                if self.db.in_transaction:
                    self.db.execute("ROLLBACK")
                raise
            response.update(ok=True, result=result)
        except ServiceError as error:
            response.update(ok=False, code=error.code, error=error.error, hint=error.hint)
        except (ValueError, TypeError, KeyError):
            response.update(ok=False, code="INVALID_REQUEST", error="请求字段无效。", hint="核对操作字段和数据类型后重试。")
        except Exception:
            response.update(ok=False, code="SERVICE_UNAVAILABLE", error="本地能力事务失败。", hint="暂停本地记忆及主动发送，检查服务环境后重试。")
        return response

    def epoch(self, character):
        return self.db.execute("SELECT memory_epoch FROM characters WHERE id=?", (character,)).fetchone()[0]

    def bump(self, character):
        self.db.execute("UPDATE characters SET memory_epoch=memory_epoch+1 WHERE id=?", (character,))
        return self.epoch(character)

    def authorize(self, request, binding=True):
        character = text(request.get("character_id"), 200)
        if character not in self.active or request.get("character_epoch") != self.active[character]:
            raise ServiceError("STALE_CHARACTER", "角色代次已失效。", "重新激活当前角色并重建会话上下文。")
        if not binding:
            return character
        token = request.get("session_binding")
        session = self.bindings.get(token) if isinstance(token, str) else None
        if not session or session["character"] != character or session["epoch"] != self.active[character]:
            raise ServiceError("BINDING_INVALID", "会话身份绑定无效。", "由受信宿主重新绑定当前会话。")
        return session

    @staticmethod
    def management(session):
        if not session["management"]:
            raise ServiceError("PERMISSION_DENIED", "此操作仅允许本机主人管理页。", "打开本机记忆管理页面操作。")

    def dispatch(self, op, request, params):
        if op in ("health", "capabilities"):
            return dict(protocol_version=1, status="ready", encrypted=True, modules=["memory", "attention", "memory_proposals", "keyword_index", "backup", "tools"], storage="SQLCipher")
        if op == "character.activate":
            character = text(params.get("character_id"), 200)
            self.db.execute("INSERT OR IGNORE INTO characters(id) VALUES(?)", (character,))
            self.invalidate(character)
            epoch = uuid.uuid4().hex
            self.active[character] = epoch
            return dict(character_id=character, character_epoch=epoch, memory_epoch=self.epoch(character))
        if op == "session.bind":
            character = self.authorize(request, False)
            return self.bind(character, params)
        if op == "lifecycle.retire":
            character = self.authorize(request, False)
            self.invalidate(character)
            self.active.pop(character)
            return dict(retired=True)
        session = self.authorize(request)
        if op.startswith('tool.'):
            return self.tools.dispatch(op, session, params)
        paused = self.db.execute('SELECT paused FROM recovery_state WHERE character=?', (session['character'],)).fetchone()
        if paused and paused[0] and (op.startswith('context.') or op in ('attention.check','attention.reserve') or (op.startswith('memory.') and not session['management'])):
            raise ServiceError('RECOVERY_REVIEW_REQUIRED', '恢复内容尚未完成主人复审。', '在管理页核对最新删除记录并明确复审；暂停生成与发送。')
        if op.startswith('memory.proposals.') or op in ('memory.episodes.pending', 'memory.resume', 'memory.index.rebuild'):
            return self.governance.dispatch(op, session, params)
        if op.startswith('backup.'):
            return self.backups.dispatch(op, session, params)
        if op == "context.validate":
            if params.get("memory_epoch") != self.epoch(session["character"]):
                raise ServiceError("STALE_CONTEXT", "记忆版本已改变。", "重新检索并生成回复，禁止发送旧上下文。")
            return dict(valid=True)
        if op == "context.sources":
            return self.context_sources(session, params)
        if op.startswith("memory."):
            return self.memory(op[7:], session, params)
        if op.startswith("attention."):
            return self.attention(op[10:], session, params)
        raise ServiceError("INVALID_REQUEST", "未知操作。")

    def invalidate(self, character):
        self.tools.retire(character)
        self.bindings = {key: value for key, value in self.bindings.items() if value["character"] != character}
        recover_reservations(self.db, character)

    def context_sources(self, session, params):
        identifiers = params.get("source_event_ids")
        if not isinstance(identifiers, list) or len(identifiers) > 20:
            raise ServiceError("INVALID_REQUEST", "来源核验最多包含 20 个事件 ID。")
        identifiers = [text(identifier, 500) for identifier in identifiers]
        if len(set(identifiers)) != len(identifiers):
            raise ServiceError("INVALID_REQUEST", "来源核验的事件 ID 必须唯一。")
        # This endpoint is a bound-context read even for a management binding.
        # Reuse query's normal audience-first dependency set and recursive gate;
        # a same-scope projection must not smuggle a hidden/inactive ancestor.
        permitted = {row["id"]: row for row in self.visible_rows(dict(session, management=False))}
        sources = []
        for identifier in identifiers:
            # Restrict the lookup itself: another audience's record or tombstone
            # must be indistinguishable from an event that never existed here.
            row = self.db.execute("SELECT * FROM memories WHERE character=? AND scope=? AND event_hash=?",
                                  (session["character"], session["scope"], digest(identifier))).fetchone()
            source = dict(source_event_id=identifier, status="missing")
            if row and row["status"] == "active" and not self.visible(row, permitted):
                row = None  # Same response as absent; do not disclose dependency state.
            if row:
                source["status"] = "suspended" if row["status"] == "invalidated" else row["status"]
                source["revision"] = row["revision"]
                if row["status"] == "active":
                    source["id"] = row["id"]
                    source["text"] = row["statement"]
            sources.append(source)
        return dict(sources=sources, memory_epoch=self.epoch(session["character"]))

    def bind(self, character, params):
        platform, account, conversation, principal = [text(params.get(key), 200) for key in
                                                    ("platform", "account_id", "conversation_id", "principal_id")]
        scope = text(params.get("audience_scope"), 650)
        owner = params.get("is_owner", False)
        management = params.get("management", False)
        if type(owner) is not bool or type(management) is not bool:
            raise ServiceError("INVALID_REQUEST", "身份标记必须为布尔值。")
        shared_owner = owner and not management and scope == "owner:local" and (platform == "pet" or (platform == "qq" and principal == conversation))
        local_owner = owner and management and platform == "local" and scope == "owner:local"
        valid = (shared_owner or (platform == "local" and scope in ("owner:local", "pet:local")) or
                 (platform == "pet" and scope == "pet:local") or
                 (platform == "qq" and scope in (f"qq:private:{account}:{conversation}", f"qq:group:{account}:{conversation}")) or
                 (platform == "bili" and scope == "bili:public"))
        if not valid or (scope == "owner:local" and not (shared_owner or local_owner)) or (management and not local_owner):
            raise ServiceError("PERMISSION_DENIED", "受众范围或主人管理绑定不匹配。")
        if scope.startswith("qq:private:") and principal != conversation:
            raise ServiceError("PERMISSION_DENIED", "私聊主体必须与会话对象匹配。")
        token = uuid.uuid4().hex
        self.bindings[token] = dict(character=character, epoch=self.active[character], scope=scope,
                                   principal=principal, management=management, owner=owner, token=token,
                                   platform=platform, account=account, conversation=conversation)
        return dict(session_binding=token)

    def record(self, row):
        return dict(id=row["id"], statement=row["statement"], revision=row["revision"], status=row["status"],
                    pinned=bool(row["pinned"]), source_refs=json.loads(row["sources"]), derived_from=json.loads(row["derived"]),
                    audience_scope=row["scope"], kind=row["kind"],
                    source_revisions={proof['source']:proof['revision'] for proof in self.db.execute('SELECT source,revision FROM record_source_revisions WHERE memory=?',(row['id'],))})

    def visible_rows(self, session):
        # Audience restriction is part of SQL, before matching/ranking. Management is an explicit separate path.
        if session["management"]:
            return self.db.execute("SELECT * FROM memories WHERE character=? ORDER BY pinned DESC,rowid DESC", (session["character"],)).fetchall()
        return self.db.execute("SELECT * FROM memories WHERE character=? AND scope IN (?, 'bili:public') AND status='active' ORDER BY pinned DESC,rowid DESC",
                               (session["character"], session["scope"])).fetchall()

    def visible(self, row, permitted, trail=None):
        trail = set() if trail is None else trail
        if row["id"] in trail:
            return False
        trail = trail | {row["id"]}
        proofs = self.db.execute('SELECT source,revision FROM record_source_revisions WHERE memory=?', (row['id'],)).fetchall()
        if any(proof['source'] not in permitted or permitted[proof['source']]['revision'] != proof['revision'] for proof in proofs):
            return False
        return all(source in permitted and permitted[source]["status"] == "active" and
                   self.visible(permitted[source], permitted, trail) for source in json.loads(row["derived"]))

    def target(self, character, params):
        row = self.db.execute("SELECT * FROM memories WHERE id=? AND character=?", (text(params.get("id"), 200), character)).fetchone()
        if not row:
            raise ServiceError("NOT_FOUND", "记录不存在。")
        return row

    def memory(self, op, session, params):
        character = session["character"]
        if op == "query":
            limit = integer(params.get("limit", 20), 1, 100)
            query = params.get("query", "")
            if not isinstance(query, str) or len(query) > 2000:
                raise ServiceError("INVALID_REQUEST", "查询过长。")
            rows = self.visible_rows(session)
            permitted = {row["id"]: row for row in rows}
            mode = params.get('search_mode', 'substring')
            if mode not in ('substring', 'keyword'):
                raise ServiceError('INVALID_REQUEST', '检索模式必须是 substring 或 keyword。')
            candidates = self.governance.keyword_ids(session, query) if mode == 'keyword' else None
            records = [self.record(row) for row in rows if (session["management"] or self.visible(row, permitted))
                       and ((row['id'] in candidates) if candidates is not None else query.casefold() in row["statement"].casefold())]
            return dict(memories=records[:limit], memory_epoch=self.epoch(character), character_epoch=session["epoch"])
        if op in ("ingest", "propose"):
            if params.get("expected_memory_epoch") != self.epoch(character):
                raise ServiceError("STALE_CONTEXT", "自动写入的记忆版本已过期。", "丢弃旧提案并重新检索。")
            if op == "propose" and (params.get("id") or params.get("target_id") or params.get("operation", "add") != "add"):
                raise ServiceError("PERMISSION_DENIED", "自动提案只能新增有来源的经历，不能覆盖用户修订。")
            if not self.db.execute("SELECT auto_write FROM characters WHERE id=?", (character,)).fetchone()[0]:
                # Disabled persistence does not bless deleted/invalid input as a
                # never-stored live source. Run only the existing read-side checks.
                self.ingest(session, params, validate_only=True)
                raise ServiceError("AUTO_WRITE_DISABLED", "已停用自动记忆整理。", "由主人在记忆管理页开启。")
            return self.ingest(session, params)
        self.management(session)
        if op == "settings":
            if "auto_write" in params:
                if type(params["auto_write"]) is not bool:
                    raise ServiceError("INVALID_REQUEST", "auto_write 必须是布尔值。")
                self.db.execute("UPDATE characters SET auto_write=? WHERE id=?", (params["auto_write"], character))
                self.bump(character)
            return dict(auto_write=bool(self.db.execute("SELECT auto_write FROM characters WHERE id=?", (character,)).fetchone()[0]), memory_epoch=self.epoch(character))
        if op == "migrate":
            return self.migrate(session, params)
        if op == "export":
            rows = self.visible_rows(session)
            revisions = [dict(row) for row in self.db.execute("SELECT r.* FROM revisions r JOIN memories m ON r.memory=m.id WHERE m.character=?", (character,))]
            return dict(memories=[self.record(row) for row in rows], episodes=[self.record(row) for row in rows if row["kind"] in ("episode", "legacy_summary")], revisions=revisions, memory_epoch=self.epoch(character))
        row = self.target(character, params)
        if op == "detail":
            return dict(memory=self.record(row), revisions=[dict(item) for item in self.db.execute("SELECT * FROM revisions WHERE memory=? ORDER BY revision", (row["id"],))], sources=json.loads(row["sources"]))
        if row["status"] == "deleted":
            if op == "delete":
                return dict(memory_epoch=self.epoch(character))
            raise ServiceError("NOT_FOUND", "记录已删除。")
        if params.get("expected_revision") != row["revision"]:
            raise ServiceError("VERSION_CONFLICT", "记录已被修改。", "刷新记录后使用最新修订号。")
        if op == "correct":
            statement = text(params.get("statement"), 12000)
            # Existing projections describe the previous source revision. Keep their
            # management history, but require fresh provenance before reuse.
            for identifier in self.affected_records(character, row["id"]) - {row["id"]}:
                self.db.execute("UPDATE memories SET status='suspended',revision=revision+1 WHERE id=? AND character=? AND status='active'", (identifier, character))
            self.db.execute("UPDATE memories SET statement=?,revision=revision+1,pinned=1 WHERE id=?", (statement, row["id"]))
            self.fingerprint(row["id"], character, "content", digest(statement))
            self.db.execute("INSERT INTO revisions VALUES(?,?,?,?)", (row["id"], row["revision"] + 1, statement, "user"))
        elif op == "suspend":
            self.db.execute("UPDATE memories SET status='suspended',revision=revision+1 WHERE id=?", (row["id"],))
        elif op == "delete":
            self.delete_tree(character, row["id"])
        else:
            raise ServiceError("INVALID_REQUEST", "未知记忆操作。")
        epoch = self.bump(character)
        self.governance.index(row['id'])
        return dict(memory=self.record(self.target(character, params)), memory_epoch=epoch)

    def fingerprint(self, memory, character, kind, hashed):
        self.db.execute("INSERT OR IGNORE INTO fingerprints VALUES(?,?,?,?)", (memory, character, kind, hashed))

    def ingest(self, session, params, migration=False, *, validate_only=False):
        character = session["character"]
        statement = text(params.get("text"), 12000)
        event = text(params.get("source_event_id"), 500)
        refs = string_list(params.get("source_refs", []))
        derived = string_list(params.get("derived_from", []))
        proofs = params.get('source_revisions') if 'source_revisions' in params else None
        if 'source_revisions' in params:
            if not isinstance(proofs,dict) or set(proofs) != set(derived) or len(set(derived)) != len(derived):
                raise ServiceError('INVALID_REQUEST','来源修订必须恰好对应全部唯一派生来源。')
            for revision in proofs.values():
                integer(revision,1,2**53-1)
        fingerprints = [("event", digest(event)), ("content", digest(statement))] + [("source", digest(ref)) for ref in refs]
        for kind, hashed in fingerprints:
            if self.db.execute("SELECT 1 FROM tombstones WHERE character=? AND kind=? AND digest=?", (character, kind, hashed)).fetchone():
                raise ServiceError("DELETED_SOURCE", "此来源或内容已被用户删除。", "不能重放删除内容；请提供新的独立来源。")
        existing = self.db.execute("SELECT id,derived,status FROM memories WHERE character=? AND scope=? AND event_hash=?", (character, session["scope"], digest(event))).fetchone()
        if existing and proofs is None and not validate_only:
            return dict(id=existing[0], duplicate=True, memory_epoch=self.epoch(character))
        if validate_only and not existing and self.db.execute('SELECT 1 FROM memories WHERE character=? AND event_hash=? LIMIT 1',(character,digest(event))).fetchone():
            raise ServiceError('PERMISSION_DENIED','此来源事件不满足当前会话的临时使用条件。','刷新来源状态；不要把不可见或隔离来源当作新材料。')
        view = dict(session,management=False) if validate_only else session
        permitted = {row["id"]: row for row in self.visible_rows(view)} if derived or (validate_only and existing) else {}
        if validate_only and existing:
            if existing['status']=='deleted':
                raise ServiceError('DELETED_SOURCE','此来源已被用户删除。','不能将删除来源作为临时新材料重放。')
            if existing['status']!='active' or not self.visible(existing,permitted):
                raise ServiceError('PERMISSION_DENIED','此来源事件不满足当前会话的临时使用条件。','刷新来源状态；不要把停用或继承不可见的来源当作新材料。')
        for source in derived:
            if source not in permitted or permitted[source]["status"] != "active" or not self.visible(permitted[source], permitted):
                raise ServiceError("PERMISSION_DENIED", "派生来源对当前受众不可见。")
            if proofs is not None and permitted[source]['revision'] != proofs[source]:
                raise ServiceError('VERSION_CONFLICT','派生来源修订已经改变。','重新读取原始来源，不得用新epoch认可旧内容。')
        if existing:
            if proofs is not None:
                stored_proofs={row['source']:row['revision'] for row in self.db.execute('SELECT source,revision FROM record_source_revisions WHERE memory=?',(existing['id'],))}
                if set(json.loads(existing['derived'])) != set(derived) or stored_proofs != proofs:
                    raise ServiceError('VERSION_CONFLICT','重复事件的来源绑定与已存记录不同。','保留原记录；重新评估并使用新的事件标识。')
            return dict(id=existing['id'],duplicate=True,memory_epoch=self.epoch(character))
        status = params.get("status", "active") if migration else "active"
        if status not in ("active", "suspended", "deleted", "invalidated"):
            raise ServiceError("INVALID_REQUEST", "迁移状态无效。")
        if validate_only:
            return dict(validated=True)
        identifier = uuid.uuid4().hex
        self.db.execute("INSERT INTO memories VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", (identifier, character, session["scope"], session["principal"], statement, 1, status, 0, digest(event), digest(statement), encode(refs), encode(derived), "legacy_summary" if migration else "episode"))
        self.db.execute("INSERT INTO revisions VALUES(?,?,?,?)", (identifier, 1, statement, "migration" if migration else "ingest"))
        for kind, hashed in fingerprints:
            self.fingerprint(identifier, character, kind, hashed)
        if proofs is not None:
            self.db.executemany('INSERT INTO record_source_revisions VALUES(?,?,?)',[(identifier,source,revision) for source,revision in proofs.items()])
        if status == "deleted":
            self.delete_tree(character, identifier)
        self.governance.index(identifier)
        return dict(id=identifier, duplicate=False, memory_epoch=self.bump(character))

    def affected_records(self, character, identifier, shared_provenance=False):
        """Follow dependencies and (for deletion) aliases within one character.

        Fingerprints retain event/source/content links even after body removal.
        Walking their transitive closure makes existing copies obey the same
        deletion boundary as later replay attempts.
        """
        dependents, links, aliases = {}, {}, {}
        for row in self.db.execute("SELECT id,derived FROM memories WHERE character=?", (character,)):
            for source in json.loads(row["derived"]):
                dependents.setdefault(source, set()).add(row["id"])
        if shared_provenance:
            for row in self.db.execute("SELECT memory,kind,digest FROM fingerprints WHERE character=?", (character,)):
                key = (row["kind"], row["digest"])
                links.setdefault(row["memory"], set()).add(key)
                aliases.setdefault(key, set()).add(row["memory"])
        affected, pending = {identifier}, [identifier]
        while pending:
            current = pending.pop()
            following = set(dependents.get(current, ()))
            for key in links.get(current, ()):
                following.update(aliases[key])
            unseen = following - affected
            affected.update(unseen)
            pending.extend(unseen)
        return affected

    def delete_tree(self, character, identifier):
        doomed = self.affected_records(character, identifier, shared_provenance=True)
        for item in doomed:
            self.db.execute("INSERT OR IGNORE INTO tombstones SELECT character,kind,digest FROM fingerprints WHERE memory=? AND character=?", (item, character))
            self.db.execute("INSERT OR IGNORE INTO sovereignty.tombstones SELECT character,kind,digest FROM fingerprints WHERE memory=? AND character=?", (item, character))
            self.db.execute("DELETE FROM revisions WHERE memory=?", (item,))
            self.db.execute("UPDATE memories SET statement='',sources='[]',derived='[]',status='deleted',revision=revision+1 WHERE id=? AND character=? AND status!='deleted'", (item, character))
        self.governance.on_delete(character, doomed)

    def migrate(self, session, params):
        migration = text(params.get("migration_id"), 200)
        records = params.get("records")
        if not isinstance(records, list) or len(records) > 500:
            raise ServiceError("INVALID_REQUEST", "迁移批次必须为至多 500 条的列表。")
        hashed = digest(encode(records))
        prior = self.db.execute("SELECT digest FROM migrations WHERE character=? AND migration=?", (session["character"], migration)).fetchone()
        if prior:
            if prior[0] != hashed:
                raise ServiceError("VERSION_CONFLICT", "同一迁移 ID 的内容已改变。")
            return dict(duplicate=True, imported=0, memory_epoch=self.epoch(session["character"]))
        quarantine = dict(session, scope="quarantine")
        imported = 0
        for record in records:
            if not isinstance(record, dict):
                raise ServiceError("INVALID_REQUEST", "迁移记录必须是对象。")
            imported += not self.ingest(quarantine, record, True)["duplicate"]
        self.db.execute("INSERT INTO migrations VALUES(?,?,?)", (session["character"], migration, hashed))
        return dict(duplicate=False, imported=imported, memory_epoch=self.epoch(session["character"]))

    def attention(self, op, session, params):
        character = session["character"]
        self.db.execute("INSERT OR IGNORE INTO attention(character,config) VALUES(?,?)", (character, encode(DEFAULT_ATTENTION)))
        state = self.db.execute("SELECT * FROM attention WHERE character=?", (character,)).fetchone()
        config = json.loads(state["config"])
        if op == "configure":
            self.management(session)
            for key in params:
                if key not in config:
                    raise ServiceError("INVALID_REQUEST", "未知主动联系设置。")
            config.update(params)
            for key in ("enabled", "muted", "focused"):
                if type(config[key]) is not bool:
                    raise ServiceError("INVALID_REQUEST", "主动开关必须为布尔值。")
            integer(config["daily_limit"], 0, 100)
            integer(config["cooldown_seconds"], 0, 604800)
            if config["timezone"] not in ("Asia/Shanghai", "UTC"):
                raise ServiceError("INVALID_REQUEST", "首期支持 Asia/Shanghai 或 UTC 时区。")
            for key in ("quiet_start", "quiet_end"):
                if not isinstance(config[key], str) or (config[key] and not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", config[key])):
                    raise ServiceError("INVALID_REQUEST", "安静时间使用 HH:MM 或空字符串。")
            if bool(config["quiet_start"]) != bool(config["quiet_end"]):
                raise ServiceError("INVALID_REQUEST", "安静时段起止必须同时设置。")
            self.db.execute("UPDATE attention SET config=? WHERE character=?", (encode(config), character))
            return dict(config=config)
        if op == "respond":
            if not session["owner"] or not (session["scope"] in ("owner:local", "pet:local") or session["scope"].startswith("qq:private:")):
                raise ServiceError("PERMISSION_DENIED", "只有绑定主人的主动输入可恢复预算。")
            self.db.execute("UPDATE attention SET unanswered=0,intensity=min(1,intensity+0.25) WHERE character=?", (character,))
            return dict(responded=True)
        identifier = text(params.get("outreach_id"), 200)
        prior = self.db.execute("SELECT * FROM outreach WHERE character=? AND id=?", (character, identifier)).fetchone()
        if op == "finalize":
            outcome = params.get("outcome")
            if outcome not in ("sent", "failed", "unknown"):
                raise ServiceError("INVALID_REQUEST", "发送结果必须是 sent、failed 或 unknown。")
            if not prior or prior["binding"] != session["token"] or prior["epoch"] != session["epoch"]:
                raise ServiceError("PERMISSION_DENIED", "预留不属于当前绑定。")
            if prior["status"] != "reserved":
                if prior["status"] == outcome:
                    return dict(status=outcome)
                raise ServiceError("VERSION_CONFLICT", "主动事件已具有不可覆盖的终态。")
            self.db.execute("UPDATE outreach SET status=? WHERE character=? AND id=?", (outcome, character, identifier))
            if outcome in ("sent", "unknown"):
                self.db.execute("UPDATE attention SET unanswered=unanswered+1,intensity=CASE WHEN unanswered+1>=3 THEN max(0.25,intensity*0.5) ELSE intensity END WHERE character=?", (character,))
            return dict(status=outcome)
        if op not in ("check", "reserve"):
            raise ServiceError("INVALID_REQUEST", "未知注意力操作。")
        reason = self.attention_reason(session, params, config, state, prior)
        if op == "check":
            return dict(allowed=not reason, reason=reason or "allowed", unanswered=state["unanswered"], intensity=state["intensity"])
        if reason:
            return dict(reserved=False, reason=reason)
        reservation = uuid.uuid4().hex
        now = self.clock()
        self.db.execute("INSERT INTO outreach VALUES(?,?,?,?,?,?,?,?)", (character, identifier, reservation, session["token"], session["epoch"], "reserved", now, self.local_now(config).date().isoformat()))
        return dict(reserved=True, reservation_id=reservation, reason="allowed")

    def local_now(self, config):
        offset = 8 if config["timezone"] == "Asia/Shanghai" else 0
        return datetime.fromtimestamp(self.clock(), timezone(timedelta(hours=offset)))

    def attention_reason(self, session, params, config, state, prior):
        if not config["enabled"]:
            return "disabled"
        if config["muted"]:
            return "muted"
        if config["focused"]:
            return "focused"
        now = self.local_now(config)
        minute = now.strftime("%H:%M")
        start, end = config["quiet_start"], config["quiet_end"]
        if start and ((start <= minute < end) if start < end else (minute >= start or minute < end)):
            return "quiet_hours"
        owned = prior and prior["status"] == "reserved" and prior["binding"] == session["token"] and prior["epoch"] == session["epoch"] and params.get("reservation_id") == prior["reservation"]
        if prior and not owned:
            return "duplicate"
        rows = self.db.execute("SELECT * FROM outreach WHERE character=? AND status IN ('reserved','sent','unknown')", (session["character"],)).fetchall()
        others = [row for row in rows if not owned or row["id"] != prior["id"]]
        if sum(row["day"] == now.date().isoformat() for row in others) >= max(0, int(config["daily_limit"] * state["intensity"])):
            return "daily_budget"
        if others and self.clock() - max(row["created"] for row in others) < config["cooldown_seconds"] / state["intensity"]:
            return "cooldown"
        if "memory_epoch" in params and params["memory_epoch"] != self.epoch(session["character"]):
            return "stale_context"
        return ""
