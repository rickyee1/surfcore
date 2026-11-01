"""Behavior and process checks; only disposable directories and synthetic content."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services/local-capabilities"))
from core import CapabilityService
from storage import ServiceError

KEY = "17" * 32


class Behavior(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="surfcore-capabilities-")
        self.directory = Path(self.temporary.name)
        self.environment = patch.dict(os.environ, SURFCORE_LOCAL_KEY=KEY)
        self.environment.start()
        self.now = 1793577600.0
        self.service = CapabilityService(self.directory, clock=lambda: self.now)
        self.epochs = {}
        self.activate("a")
        self.owner = self.bind("owner:local", owner=True, management=True)
        self.pet = self.bind("pet:local", owner=True)
        self.alice = self.bind("qq:private:bot:alice", principal="alice", owner=True)
        self.bob = self.bind("qq:private:bot:bob", principal="bob")
        self.group1 = self.bind("qq:group:bot:one", principal="alice", owner=True)
        self.group2 = self.bind("qq:group:bot:two", principal="bob")
        self.public = self.bind("bili:public")

    def tearDown(self):
        self.service.close()
        self.environment.stop()
        self.temporary.cleanup()

    def call(self, op, params=None, binding=None, character="a", **fields):
        request = dict(protocol_version=1, request_id="test", op=op, params=params or {},
                       character_id=character, character_epoch=self.epochs.get(character), session_binding=binding,
                       deadline=self.now * 1000 + 60000)
        request.update(fields)
        return self.service.handle(request)

    def good(self, response):
        self.assertTrue(response["ok"], response)
        return response["result"]

    def bad(self, response, code):
        self.assertFalse(response["ok"], response)
        self.assertEqual(response["code"], code)
        self.assertTrue(response["error"])
        self.assertTrue(response["hint"])

    def activate(self, character):
        result = self.good(self.call("character.activate", dict(character_id=character)))
        self.epochs[character] = result["character_epoch"]

    def bind(self, scope, principal="local", owner=False, management=False, character="a"):
        platform = "qq" if scope.startswith("qq:") else "bili" if scope.startswith("bili:") else "local"
        conversation = scope.split(":")[-1]
        return self.good(self.call("session.bind", dict(platform=platform, account_id="bot", conversation_id=conversation,
                            principal_id=principal, audience_scope=scope, is_owner=owner, management=management), character=character))["session_binding"]

    def epoch(self, character="a"):
        return self.service.epoch(character)

    def ingest(self, binding, event, statement, character="a", **extra):
        return self.call("memory.ingest", dict(source_event_id=event, text=statement, source_refs=["source:" + event],
                        expected_memory_epoch=self.epoch(character), **extra), binding, character)

    def query(self, binding, character="a", **params):
        return self.good(self.call("memory.query", params, binding, character))["memories"]

    def configure(self, **params):
        return self.good(self.call("attention.configure", params, self.owner))

    def reserve(self, event, binding=None):
        return self.good(self.call("attention.reserve", dict(outreach_id=event), binding or self.pet))

    def test_audience_before_retrieval_and_cross_character(self):
        for binding, name in [(self.pet,"pet"), (self.alice,"alice"), (self.bob,"bob"), (self.group1,"one"), (self.group2,"two"), (self.public,"public")]:
            self.good(self.ingest(binding, name, "needle-" + name))
        for binding, name in [(self.pet,"pet"), (self.alice,"alice"), (self.bob,"bob"), (self.group1,"one"), (self.group2,"two")]:
            self.assertEqual({row["statement"] for row in self.query(binding)}, {"needle-" + name, "needle-public"})
            self.assertEqual(len(self.query(binding, query="needle", limit=1)), 1)
        self.assertEqual(len(self.query(self.owner)), 6)
        self.activate("b")
        other = self.bind("pet:local", owner=True, character="b")
        self.assertEqual(self.query(other, "b"), [])
        self.bad(self.call("memory.query", {}, self.pet, "b"), "BINDING_INVALID")

    def test_context_sources_exact_lookup_survives_intervening_ingestion(self):
        first = self.good(self.ingest(self.pet, "burst-first", "First actual source"))
        for number in range(25):
            self.good(self.ingest(self.pet, f"burst-{number}", f"Later source {number}"))
        result = self.good(self.call("context.sources", dict(source_event_ids=["burst-first", "burst-24"]), self.pet))
        self.assertEqual(result["sources"], [dict(source_event_id="burst-first",status="active",text="First actual source",revision=1),
            dict(source_event_id="burst-24",status="active",text="Later source 24",revision=1)])
        self.assertEqual(result["memory_epoch"], self.epoch())
        self.good(self.call("memory.correct", dict(id=first["id"],statement="Corrected actual source",expected_revision=1), self.owner))
        result = self.good(self.call("context.sources", dict(source_event_ids=["burst-first"]), self.pet))
        self.assertEqual(result["sources"][0], dict(source_event_id="burst-first",status="active",text="Corrected actual source",revision=2))
        self.assertEqual(result["memory_epoch"], self.epoch())

    def test_bounded_context_query_prioritizes_user_corrections_then_newest(self):
        old = self.good(self.ingest(self.pet, "old-preference", "Old preference"))
        newest = None
        for number in range(25):
            newest = self.good(self.ingest(self.pet, f"recent-{number}", f"Recent episode {number}"))
        before = self.query(self.pet, limit=20)
        self.assertEqual(len(before), 20)
        self.assertEqual(before[0]["id"], newest["id"])
        self.assertNotIn(old["id"], [row["id"] for row in before])
        self.good(self.call("memory.correct", dict(id=old["id"],statement="User corrected preference",expected_revision=1), self.owner))
        after = self.query(self.pet, limit=20)
        self.assertEqual(after[0]["id"], old["id"])
        self.assertEqual(after[0]["statement"], "User corrected preference")
        self.assertEqual(after[1]["id"], newest["id"])

    def test_context_sources_inactive_and_deleted_after_restart(self):
        first = self.good(self.ingest(self.pet, "source-suspended", "Suspended private body"))
        second = self.good(self.ingest(self.pet, "source-deleted", "Deleted private body"))
        self.good(self.call("memory.suspend", dict(id=first["id"],expected_revision=1), self.owner))
        self.good(self.call("memory.delete", dict(id=second["id"],expected_revision=1), self.owner))
        for restart in (False, True):
            if restart:
                self.service.close()
                self.service = CapabilityService(self.directory, clock=lambda: self.now)
                self.activate("a")
                self.pet = self.bind("pet:local", owner=True)
            result = self.good(self.call("context.sources", dict(source_event_ids=["source-suspended","source-deleted","never-stored"]), self.pet))
            self.assertEqual([row["status"] for row in result["sources"]], ["suspended","deleted","missing"])
            self.assertTrue(all("text" not in row for row in result["sources"]))
            self.assertNotIn("revision", result["sources"][2])

    def test_context_sources_does_not_disclose_other_audiences_or_characters(self):
        private = self.good(self.ingest(self.pet, "scope-secret", "Secret body"))
        self.good(self.ingest(self.public, "public-source", "Public body"))
        for binding in (self.alice, self.group1, self.owner):
            result = self.good(self.call("context.sources", dict(source_event_ids=["scope-secret","public-source"]), binding))
            self.assertEqual(result["sources"], [dict(source_event_id="scope-secret",status="missing"),dict(source_event_id="public-source",status="missing")])
        self.good(self.call("memory.delete", dict(id=private["id"],expected_revision=1), self.owner))
        self.assertEqual(self.good(self.call("context.sources", dict(source_event_ids=["scope-secret"]), self.group1))["sources"],
                         [dict(source_event_id="scope-secret",status="missing")])
        self.activate("b")
        other = self.bind("pet:local", owner=True, character="b")
        self.assertEqual(self.good(self.call("context.sources", dict(source_event_ids=["scope-secret"]), other,"b"))["sources"],
                         [dict(source_event_id="scope-secret",status="missing")])

    def test_context_sources_rejects_malformed_oversized_and_unbound_requests(self):
        for identifiers in (None,"event",{},["same","same"],[""],[4],["x" * 501],[str(number) for number in range(21)]):
            self.bad(self.call("context.sources", dict(source_event_ids=identifiers), self.pet), "INVALID_REQUEST")
        self.assertEqual(self.good(self.call("context.sources",dict(source_event_ids=[]),self.pet))["sources"], [])
        self.bad(self.call("context.sources",dict(source_event_ids=["event"]),"forged"), "BINDING_INVALID")

    def test_context_sources_hides_recursive_suspended_dependencies_after_restart(self):
        parent = self.good(self.ingest(self.pet, "visibility-parent", "Private root source"))
        child = self.good(self.ingest(self.pet, "visibility-child", "Private child projection", derived_from=[parent["id"]]))
        self.good(self.ingest(self.pet, "visibility-grandchild", "Private grandchild projection", derived_from=[child["id"]]))
        source_ids = ["visibility-child", "visibility-grandchild"]
        visible = self.good(self.call("context.sources", dict(source_event_ids=source_ids), self.pet))
        self.assertTrue(all(row["status"] == "active" and "text" in row for row in visible["sources"]))
        self.good(self.call("memory.suspend", dict(id=parent["id"],expected_revision=1), self.owner))
        for restart in (False, True):
            if restart:
                self.service.close()
                self.service = CapabilityService(self.directory, clock=lambda: self.now)
                self.activate("a")
                self.pet = self.bind("pet:local", owner=True)
            self.assertEqual(self.query(self.pet), [])
            hidden = self.good(self.call("context.sources", dict(source_event_ids=source_ids), self.pet))
            self.assertEqual(hidden["sources"], [dict(source_event_id=identifier,status="missing") for identifier in source_ids])

    def test_context_sources_hides_cross_scope_inherited_dependencies(self):
        private = self.good(self.ingest(self.pet, "inherited-pet", "Pet only inherited secret"))
        child = self.good(self.ingest(self.owner, "inherited-owner", "Owner summary of pet secret", derived_from=[private["id"]]))
        self.good(self.ingest(self.owner, "inherited-owner-grandchild", "Owner grandchild secret", derived_from=[child["id"]]))
        for restart in (False, True):
            if restart:
                self.service.close()
                self.service = CapabilityService(self.directory, clock=lambda: self.now)
                self.activate("a")
                self.owner = self.bind("owner:local", owner=True, management=True)
            shared = self.good(self.call("session.bind", dict(platform="qq",account_id="bot",conversation_id="alice",
                principal_id="alice",audience_scope="owner:local",is_owner=True,management=False)))["session_binding"]
            self.assertEqual(self.query(shared), [])
            for binding in (shared, self.owner):
                hidden = self.good(self.call("context.sources", dict(source_event_ids=["inherited-owner","inherited-owner-grandchild"]), binding))
                self.assertEqual(hidden["sources"], [dict(source_event_id=identifier,status="missing") for identifier in
                    ["inherited-owner","inherited-owner-grandchild"]])

    def test_forged_binding_and_management(self):
        self.bad(self.call("session.bind", dict(platform="qq", account_id="bot", conversation_id="alice", principal_id="bob",
                        audience_scope="qq:private:bot:alice")), "PERMISSION_DENIED")
        self.bad(self.call("session.bind", dict(platform="qq", account_id="bot", conversation_id="one", principal_id="alice",
                        audience_scope="owner:local", is_owner=True, management=True)), "PERMISSION_DENIED")
        self.bad(self.call("memory.export", {}, self.alice), "PERMISSION_DENIED")
        self.bad(self.call("memory.query", {}, "forged"), "BINDING_INVALID")
        self.bad(self.call("session.bind", dict(platform="local",account_id="bot",conversation_id="local",principal_id="local",audience_scope="quarantine")), "PERMISSION_DENIED")

    def test_explicit_owner_mapping_shares_only_owner_scope(self):
        bindings = []
        for platform, peer in [("pet", "local"), ("qq", "alice")]:
            binding = self.good(self.call("session.bind", dict(platform=platform, account_id="bot", conversation_id=peer,
                principal_id=peer, audience_scope="owner:local", is_owner=True, management=False)))["session_binding"]
            bindings.append(binding)
        self.good(self.ingest(bindings[0], "shared", "explicit owner cross-channel memory"))
        self.assertEqual(self.query(bindings[1])[0]["statement"], "explicit owner cross-channel memory")
        self.assertFalse(self.query(self.pet))
        self.assertFalse(self.query(self.group1))
        self.bad(self.call("memory.export", {}, bindings[1]), "PERMISSION_DENIED")

    def test_user_correction_wins_over_stale_writer_and_auto_disable(self):
        memory = self.good(self.ingest(self.pet, "coffee", "I drink coffee"))
        old_epoch = self.epoch()
        corrected = self.good(self.call("memory.correct", dict(id=memory["id"], statement="I no longer drink coffee", expected_revision=1), self.owner))
        self.assertTrue(corrected["memory"]["pinned"])
        self.bad(self.call("memory.propose", dict(text="I drink coffee", source_event_id="late", expected_memory_epoch=old_epoch), self.pet), "STALE_CONTEXT")
        self.bad(self.call("memory.propose", dict(target_id=memory["id"], operation="supersede", expected_memory_epoch=self.epoch()), self.pet), "PERMISSION_DENIED")
        self.bad(self.call("memory.correct", dict(id=memory["id"], statement="stale", expected_revision=1), self.owner), "VERSION_CONFLICT")
        self.bad(self.call("context.validate", dict(memory_epoch=old_epoch), self.pet), "STALE_CONTEXT")
        detail = self.good(self.call("memory.detail", dict(id=memory["id"]), self.owner))
        self.assertEqual([row["actor"] for row in detail["revisions"]], ["ingest", "user"])
        self.good(self.call("memory.settings", dict(auto_write=False), self.owner))
        self.bad(self.ingest(self.pet, "disabled", "ignored"), "AUTO_WRITE_DISABLED")

    def test_derived_all_sources_visible_and_delete_cascade(self):
        private = self.good(self.ingest(self.pet, "secret", "very private secret"))
        self.bad(self.ingest(self.group1, "leak", "combined", derived_from=[private["id"]]), "PERMISSION_DENIED")
        # Management can explicitly derive into owner scope; groups still cannot read it.
        derived = self.good(self.ingest(self.owner, "combined", "combined private summary", derived_from=[private["id"]]))
        self.assertFalse(self.query(self.group1))
        epoch = self.epoch()
        self.good(self.call("memory.delete", dict(id=private["id"], expected_revision=1), self.owner))
        self.bad(self.call("context.validate", dict(memory_epoch=epoch), self.pet), "STALE_CONTEXT")
        exported = self.good(self.call("memory.export", {}, self.owner))
        body = json.dumps(exported)
        self.assertNotIn("very private secret", body)
        self.assertNotIn("combined private summary", body)
        self.assertEqual({row["status"] for row in exported["memories"]}, {"deleted"})
        self.bad(self.ingest(self.pet, "secret", "different text"), "DELETED_SOURCE")
        self.bad(self.ingest(self.group1, "new-source", "very private secret"), "DELETED_SOURCE")
        self.bad(self.ingest(self.pet, "combined", "combined private summary"), "DELETED_SOURCE")
        # Retrying exactly the user's deletion is safe, even with the original revision.
        after = self.epoch()
        self.good(self.call("memory.delete", dict(id=private["id"], expected_revision=1), self.owner))
        self.assertEqual(self.epoch(), after)
        self.service.close()
        self.service = CapabilityService(self.directory, clock=lambda: self.now)
        self.activate("a")
        self.pet = self.bind("pet:local", owner=True)
        self.bad(self.ingest(self.pet, "fresh-event", "very private secret"), "DELETED_SOURCE")
        self.assertFalse(self.query(self.pet))

    def test_correction_suspends_chained_descendants_and_preserves_history(self):
        parent = self.good(self.ingest(self.pet, "correct-parent", "I drink coffee"))
        child = self.good(self.ingest(self.pet, "correct-child", "User prefers coffee", derived_from=[parent["id"]]))
        grandchild = self.good(self.ingest(self.pet, "correct-grandchild", "Offer the user coffee", derived_from=[child["id"]]))
        independent = self.good(self.ingest(self.pet, "independent", "Independent memory"))
        old_epoch = self.epoch()
        self.good(self.call("memory.correct", dict(id=parent["id"], statement="I no longer drink coffee", expected_revision=1), self.owner))
        self.assertEqual({row["id"] for row in self.query(self.pet)}, {parent["id"], independent["id"]})
        for identifier in (child["id"], grandchild["id"]):
            detail = self.good(self.call("memory.detail", dict(id=identifier), self.owner))
            self.assertEqual(detail["memory"]["status"], "suspended")
            self.assertEqual(detail["memory"]["revision"], 2)
            self.assertEqual(len(detail["revisions"]), 1)
        self.bad(self.call("context.validate", dict(memory_epoch=old_epoch), self.pet), "STALE_CONTEXT")
        self.bad(self.ingest(self.pet, "late-derived", "Stale coffee advice", derived_from=[grandchild["id"]]), "PERMISSION_DENIED")
        self.service.close()
        self.service = CapabilityService(self.directory, clock=lambda: self.now)
        self.activate("a")
        self.pet = self.bind("pet:local", owner=True)
        self.assertEqual({row["id"] for row in self.query(self.pet)}, {parent["id"], independent["id"]})

    def test_delete_shared_provenance_aliases_and_recursive_copies_after_restart(self):
        def sourced(binding, event, statement, refs, character="a", derived=None):
            return self.good(self.call("memory.ingest", dict(source_event_id=event, text=statement, source_refs=refs,
                derived_from=derived or [], expected_memory_epoch=self.epoch(character)), binding, character))
        first = sourced(self.pet, "first", "Original source body", ["msg:123"])
        alias = sourced(self.alice, "summary", "Existing source summary", ["msg:123", "msg:456"])
        transitive_alias = sourced(self.group1, "other-summary", "Linked second source summary", ["msg:456"])
        descendant = sourced(self.alice, "derived-summary", "Recursive summary child", [], derived=[alias["id"]])
        event_alias = sourced(self.group2, "first", "Same event in another audience", [])
        unrelated = sourced(self.pet, "unrelated", "Unrelated retained body", ["msg:789"])
        self.activate("b")
        other = self.bind("pet:local", owner=True, character="b")
        untouched = sourced(other, "first", "Original source body", ["msg:123"], character="b")
        self.good(self.call("memory.delete", dict(id=first["id"], expected_revision=1), self.owner))
        exported = self.good(self.call("memory.export", {}, self.owner))
        for identifier in (first["id"], alias["id"], transitive_alias["id"], descendant["id"], event_alias["id"]):
            record = next(row for row in exported["memories"] if row["id"] == identifier)
            self.assertEqual(record["status"], "deleted")
            self.assertEqual(record["statement"], "")
            self.assertEqual(record["source_refs"], [])
            self.assertFalse([row for row in exported["revisions"] if row["memory"] == identifier])
        self.assertEqual([row["id"] for row in self.query(self.pet)], [unrelated["id"]])
        self.assertEqual([row["id"] for row in self.query(other, "b")], [untouched["id"]])
        self.service.close()
        self.service = CapabilityService(self.directory, clock=lambda: self.now)
        self.activate("a")
        self.pet = self.bind("pet:local", owner=True)
        self.assertEqual([row["id"] for row in self.query(self.pet)], [unrelated["id"]])
        for event, statement, refs in [("fresh-1", "New wording", ["msg:456"]), ("summary", "New wording", []),
                                       ("fresh-2", "Existing source summary", [])]:
            self.bad(self.call("memory.ingest", dict(source_event_id=event,text=statement,source_refs=refs,
                expected_memory_epoch=self.epoch()), self.pet), "DELETED_SOURCE")
        self.activate("b")
        other = self.bind("pet:local", owner=True, character="b")
        self.assertEqual([row["id"] for row in self.query(other, "b")], [untouched["id"]])

    def test_suspend_and_migration_atomic_quarantine_idempotent(self):
        memory = self.good(self.ingest(self.pet, "suspend", "suspend me"))
        self.good(self.call("memory.suspend", dict(id=memory["id"], expected_revision=1), self.owner))
        self.assertFalse(self.query(self.pet))
        records = [dict(source_event_id="legacy-1", text="legacy summary", source_refs=["legacy:file"], status="active")]
        params = dict(migration_id="migration-1", records=records)
        self.assertEqual(self.good(self.call("memory.migrate", params, self.owner))["imported"], 1)
        self.assertTrue(self.good(self.call("memory.migrate", params, self.owner))["duplicate"])
        self.assertFalse(self.query(self.pet))
        imported = [row for row in self.query(self.owner) if row["kind"] == "legacy_summary"]
        self.assertEqual(imported[0]["audience_scope"], "quarantine")
        params = dict(migration_id="bad-batch", records=[dict(source_event_id="would-write",text="rollback"), dict(source_event_id="bad", text=4)])
        self.bad(self.call("memory.migrate", params, self.owner), "INVALID_REQUEST")
        self.assertNotIn("rollback", json.dumps(self.query(self.owner)))
        params = dict(migration_id="migration-1", records=[])
        self.bad(self.call("memory.migrate", params, self.owner), "VERSION_CONFLICT")

    def test_restart_encrypted_persistent_and_missing_key(self):
        self.good(self.ingest(self.pet, "restart", "persistent-only-encrypted"))
        self.configure(enabled=True, cooldown_seconds=0, daily_limit=3)
        self.assertTrue(self.reserve("uncertain")["reserved"])
        old_binding = self.pet
        self.service.close()
        self.assertNotEqual((self.directory / "memory.db").read_bytes()[:16], b"SQLite format 3\x00")
        for path in self.directory.iterdir():
            self.assertNotIn(b"persistent-only-encrypted", path.read_bytes())
        self.service = CapabilityService(self.directory, clock=lambda: self.now)
        self.bad(self.call("memory.query", {}, old_binding), "STALE_CHARACTER")
        self.activate("a")
        self.owner = self.bind("owner:local", owner=True, management=True)
        self.pet = self.bind("pet:local", owner=True)
        self.assertEqual(self.query(self.pet)[0]["statement"], "persistent-only-encrypted")
        self.assertEqual(self.reserve("uncertain")["reason"], "duplicate")
        self.service.close()
        with patch.dict(os.environ):
            os.environ.pop("SURFCORE_LOCAL_KEY", None)
            with self.assertRaises(ServiceError) as caught:
                CapabilityService(self.directory)
            self.assertEqual(caught.exception.code, "KEY_UNAVAILABLE")
        with patch.dict(os.environ, SURFCORE_LOCAL_KEY="99" * 32):
            with self.assertRaises(ServiceError) as caught:
                CapabilityService(self.directory)
            self.assertEqual(caught.exception.code, "KEY_UNAVAILABLE")

    def test_exclusive_lock(self):
        with self.assertRaises(ServiceError) as caught:
            CapabilityService(self.directory)
        self.assertEqual(caught.exception.code, "DATA_LOCKED")
        self.good(self.call("health"))

    def test_attention_shared_dedupe_unknown_and_final_check(self):
        self.configure(enabled=True, daily_limit=3, cooldown_seconds=0)
        reservation = self.reserve("same")
        self.assertTrue(reservation["reserved"])
        self.assertEqual(self.reserve("same", self.alice)["reason"], "duplicate")
        params = dict(outreach_id="same", reservation_id=reservation["reservation_id"], memory_epoch=self.epoch())
        self.assertTrue(self.good(self.call("attention.check", params, self.pet))["allowed"])
        self.configure(focused=True)
        self.assertEqual(self.good(self.call("attention.check", params, self.pet))["reason"], "focused")
        self.configure(focused=False)
        self.good(self.call("attention.finalize", dict(outreach_id="same", outcome="unknown"), self.pet))
        self.bad(self.call("attention.finalize", dict(outreach_id="same", outcome="failed"), self.pet), "VERSION_CONFLICT")
        self.assertEqual(self.reserve("same")["reason"], "duplicate")
        self.good(self.call("attention.finalize", dict(outreach_id="same", outcome="unknown"), self.pet))
        self.assertTrue(self.reserve("failed")["reserved"])
        self.good(self.call("attention.finalize", dict(outreach_id="failed", outcome="failed"), self.pet))
        self.assertEqual(self.reserve("failed")["reason"], "duplicate")
        self.assertTrue(self.reserve("third")["reserved"])

    def test_attention_quiet_midnight_muted_decay_and_owner_response(self):
        self.configure(enabled=True, cooldown_seconds=0, daily_limit=20, quiet_start="22:00", quiet_end="09:00")
        self.now = 1793548800.0  # UTC 16:00, local midnight
        self.assertEqual(self.reserve("quiet")["reason"], "quiet_hours")
        self.configure(quiet_start="", quiet_end="", muted=True)
        self.assertEqual(self.reserve("mute")["reason"], "muted")
        self.configure(muted=False)
        for event in ("one", "two", "three"):
            self.assertTrue(self.reserve(event)["reserved"])
            self.good(self.call("attention.finalize", dict(outreach_id=event, outcome="sent"), self.pet))
        check = self.good(self.call("attention.check", dict(outreach_id="four"), self.pet))
        self.assertEqual(check["unanswered"], 3)
        self.assertEqual(check["intensity"], 0.5)
        self.bad(self.call("attention.respond", {}, self.group1), "PERMISSION_DENIED")
        self.bad(self.call("attention.respond", {}, self.bob), "PERMISSION_DENIED")
        self.good(self.call("attention.respond", {}, self.alice))
        check = self.good(self.call("attention.check", dict(outreach_id="four"), self.pet))
        self.assertEqual(check["unanswered"], 0)
        self.assertEqual(check["intensity"], 0.75)

    def test_lifecycle_and_protocol_failure(self):
        old_epoch = self.epochs["a"]
        self.activate("a")
        self.bad(self.call("memory.query", {}, self.pet, character_epoch=old_epoch), "STALE_CHARACTER")
        self.bad(self.call("memory.query", {}, self.pet), "BINDING_INVALID")
        self.bad(self.call("health", protocol_version=2), "PROTOCOL_MISMATCH")
        self.bad(self.call("health", deadline=1), "REQUEST_CANCELLED")
        self.bad(self.call("health", cancelled=True), "REQUEST_CANCELLED")
        self.bad(self.call("unknown"), "BINDING_INVALID")


class Transport(unittest.TestCase):
    @unittest.skipUnless(os.name == "nt", "DPAPI requires Windows")
    def test_dpapi_fresh_key_provisioning_and_reopen(self):
        with tempfile.TemporaryDirectory(prefix="surfcore-dpapi-") as directory, patch.dict(os.environ):
            os.environ.pop("SURFCORE_LOCAL_KEY", None)
            service = CapabilityService(directory)
            self.assertTrue(service.handle(dict(protocol_version=1, request_id="dpapi", op="health"))["ok"])
            service.close()
            protected = (Path(directory) / "key.dpapi").read_bytes()
            self.assertGreater(len(protected), 32)
            service = CapabilityService(directory)
            service.close()
            self.assertEqual(protected, (Path(directory) / "key.dpapi").read_bytes())

    def test_plaintext_database_rejected_without_modification(self):
        with tempfile.TemporaryDirectory(prefix="surfcore-plaintext-") as directory, patch.dict(os.environ, SURFCORE_LOCAL_KEY=KEY):
            path = Path(directory) / "memory.db"
            original = b"SQLite format 3\x00" + b"synthetic plaintext"
            path.write_bytes(original)
            with self.assertRaises(ServiceError) as caught:
                CapabilityService(directory)
            self.assertEqual(caught.exception.code, "KEY_UNAVAILABLE")
            self.assertEqual(original, path.read_bytes())

    def test_jsonl_errors_eof_and_reopen(self):
        with tempfile.TemporaryDirectory(prefix="surfcore-transport-") as directory:
            command = [sys.executable, str(ROOT / "services/local-capabilities/server.py"), "--data-dir", directory]
            env = dict(os.environ, SURFCORE_LOCAL_KEY=KEY)
            request = dict(protocol_version=1,request_id="health",op="health")
            process = subprocess.run(command, input="bad json\n" + json.dumps(request) + "\n", text=True,
                                     encoding="utf-8", capture_output=True, env=env, timeout=20)
            self.assertEqual(process.returncode, 0, process.stderr)
            responses = [json.loads(line) for line in process.stdout.splitlines()]
            self.assertEqual(responses[0]["code"], "INVALID_REQUEST")
            self.assertTrue(responses[0]["hint"])
            self.assertTrue(responses[1]["ok"])
            process = subprocess.run(command, input=json.dumps(request)+"\n", text=True, encoding="utf-8", capture_output=True, env=env, timeout=20)
            self.assertTrue(json.loads(process.stdout)["ok"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
