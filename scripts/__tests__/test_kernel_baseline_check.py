"""Unit regressions for the CI proof, without Docker or external databases."""
import contextlib
import copy
import hashlib
import importlib.util
import pathlib
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location(
    "kernel_baseline", pathlib.Path(__file__).resolve().parents[1] / "kernel-baseline.py")
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)


class AdoptionCheckTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = pathlib.Path(self.temporary.name)
        self.files = [root / "0217_first.sql", root / "0218_second.sql"]
        for file, ddl in zip(self.files, (
            "CREATE TABLE kernel.probe(id integer);",
            "ALTER TABLE kernel.probe ADD COLUMN label text;",
        )):
            file.write_text(ddl)
        self.history = [{"filename": "0215_history.sql", "checksum": "reviewed",
                         "id": 212, "applied_at": "2000-01-01"}]
        self.states = {"restored": {"ledger": copy.deepcopy(self.history), "schema": []}}
        self.calls = 0
        self.skipped = set()
        self.mutation = lambda state: None
        self.scratch = Mock()
        self.scratch.sql.side_effect = self.sql
        self.scratch.dump.side_effect = lambda db: self.states[db]["schema"]
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        replacements = {
            "ledger_state": lambda scratch, db: copy.deepcopy(self.states[db]["ledger"]),
            "post_cut_files": lambda: self.files,
            "apply_migration": self.apply,
            "migrate": self.migrate,
            "all_data": lambda scratch, db, normalize_seeds=False: "data",
            "relation_identities": lambda scratch, db: {"kernel.existing": ("1", "1")},
            "snapshot": lambda scratch, db: copy.deepcopy(self.states[db]),
        }
        for name, replacement in replacements.items():
            self.stack.enter_context(patch.object(CHECK, name, side_effect=replacement))

    def sql(self, db, content):
        if content.startswith("CREATE DATABASE "):
            self.states[content.split()[2]] = copy.deepcopy(self.states["restored"])
        return "1" if "count(*)" in content else "extensions"

    def apply(self, scratch, db, file):
        self.states[db]["schema"].append(file.read_text())
        self.states[db]["ledger"].append({
            "filename": file.name, "checksum": hashlib.sha256(file.read_bytes()).hexdigest()})
        self.states[db]["ledger"].sort(key=lambda row: row["filename"])

    def migrate(self, scratch, db):
        self.calls += 1
        state = self.states[db]
        if self.calls == 1:
            tracked = {row["filename"] for row in state["ledger"]}
            for file in self.files:
                if file.name not in tracked and file.name not in self.skipped:
                    self.apply(scratch, db, file)
            if CHECK.BASELINE not in tracked:
                state["ledger"].append({
                    "filename": CHECK.BASELINE,
                    "checksum": hashlib.sha256((CHECK.MIGRATIONS / CHECK.BASELINE).read_bytes()).hexdigest()})
            state["ledger"].sort(key=lambda row: row["filename"])
        self.mutation(state)
        return "runner output"

    def test_two_schema_changing_files_replayed_in_order(self):
        self.assertEqual(CHECK.verify_adoption(self.scratch, "restored"), "runner output")
        self.assertEqual(CHECK.apply_migration.call_count, 2)
        self.assertEqual([call.args[2] for call in CHECK.apply_migration.call_args_list], self.files)
        self.assertEqual(self.calls, 2)

    def test_dev_skips_existing_post_cut_rows(self):
        for file in self.files:
            self.apply(self.scratch, "restored", file)
        CHECK.verify_adoption(self.scratch, "restored")
        CHECK.apply_migration.assert_not_called()

    def test_mixed_ledger_replays_only_pending_files(self):
        self.apply(self.scratch, "restored", self.files[0])
        CHECK.verify_adoption(self.scratch, "restored")
        self.assertEqual([call.args[2] for call in CHECK.apply_migration.call_args_list], self.files[1:])

    def test_no_post_cut_files(self):
        self.files = []
        CHECK.verify_adoption(self.scratch, "restored")
        CHECK.apply_migration.assert_not_called()
        self.assertFalse(any(call.args[2] for call in CHECK.all_data.call_args_list if len(call.args) > 2))

    def test_already_adopted_baseline_is_preserved(self):
        self.states["restored"]["ledger"].insert(0, {
            "filename": CHECK.BASELINE, "checksum": "existing", "id": 213})
        CHECK.verify_adoption(self.scratch, "restored")

    def test_omitting_second_migration_fails(self):
        self.skipped.add(self.files[1].name)
        with self.assertRaisesRegex(RuntimeError, "all pending post-cut"):
            CHECK.verify_adoption(self.scratch, "restored")

    def test_historical_ledger_rewrite_fails(self):
        self.mutation = lambda state: next(row for row in state["ledger"]
                                          if row["filename"] == "0215_history.sql").update(checksum="rewritten")
        with self.assertRaisesRegex(RuntimeError, "historical ledger"):
            CHECK.verify_adoption(self.scratch, "restored")

    def test_wrong_pending_checksum_fails(self):
        self.mutation = lambda state: next(row for row in state["ledger"]
                                          if row["filename"] == self.files[0].name).update(checksum="wrong")
        with self.assertRaisesRegex(RuntimeError, "canonical post-cut"):
            CHECK.verify_adoption(self.scratch, "restored")

    def test_unexpected_ledger_addition_fails(self):
        self.mutation = lambda state: state["ledger"].append({"filename": "unexpected", "checksum": "x"})
        with self.assertRaisesRegex(RuntimeError, "only the baseline"):
            CHECK.verify_adoption(self.scratch, "restored")

    def test_second_run_mutation_fails(self):
        def mutate(state):
            if self.calls == 2:
                state["schema"].append("unexpected DDL")
        self.mutation = mutate
        with self.assertRaisesRegex(RuntimeError, "Repeated adoption"):
            CHECK.verify_adoption(self.scratch, "restored")

    def test_unexpected_identity_change_fails(self):
        CHECK.relation_identities.side_effect = [
            {"kernel.existing": ("1", "1")}, {"kernel.existing": ("1", "1")},
            {"kernel.existing": ("2", "2")},
        ]
        with self.assertRaisesRegex(RuntimeError, "object identities"):
            CHECK.verify_adoption(self.scratch, "restored")

    def test_data_mismatch_against_replay_fails(self):
        CHECK.all_data.side_effect = lambda scratch, db, normalize_seeds=False: db
        with self.assertRaisesRegex(RuntimeError, "all pending post-cut"):
            CHECK.verify_adoption(self.scratch, "restored")

    def test_extension_mismatch_against_replay_fails(self):
        def sql(db, content):
            return db if content == CHECK.EXTENSIONS else self.sql(db, content)
        self.scratch.sql.side_effect = sql
        with self.assertRaisesRegex(RuntimeError, "all pending post-cut"):
            CHECK.verify_adoption(self.scratch, "restored")

    def test_missing_baseline_row_fails(self):
        def sql(db, content):
            return "0" if "count(*)" in content else self.sql(db, content)
        self.scratch.sql.side_effect = sql
        with self.assertRaisesRegex(RuntimeError, "exactly one baseline"):
            CHECK.verify_adoption(self.scratch, "restored")

    def test_wrong_baseline_checksum_fails(self):
        self.mutation = lambda state: state["ledger"][0].update(checksum="wrong")
        with self.assertRaisesRegex(RuntimeError, "only the baseline"):
            CHECK.verify_adoption(self.scratch, "restored")

    def test_second_run_ledger_timestamp_rewrite_fails(self):
        def mutate(state):
            if self.calls == 2:
                state["ledger"][0]["applied_at"] = "changed"
        self.mutation = mutate
        with self.assertRaisesRegex(RuntimeError, "Repeated adoption"):
            CHECK.verify_adoption(self.scratch, "restored")


class DataComparisonTests(unittest.TestCase):
    def test_snapshot_samples_existing_tables_but_allows_kernel_only_init(self):
        scratch = Mock()
        scratch.sql.side_effect = ["objects", "t", "chat rows", "f"]
        with patch.object(CHECK, "ledger_state", return_value=[]):
            self.assertEqual(CHECK.snapshot(scratch, "fresh"), "objectschat rows[]")
        queries = [call.args[1] for call in scratch.sql.call_args_list]
        self.assertIn("SELECT xmin::text,to_jsonb(t) FROM chat.conversation_reads_v2 t", queries)
        self.assertNotIn("SELECT xmin::text,to_jsonb(t) FROM events.events t", queries)

    def test_normalizes_only_declared_static_seeds_for_independent_replay(self):
        with patch.object(CHECK, "run", return_value="raw non-seed data") as run, \
                patch.object(CHECK, "seed_rows", return_value=[]) as seeds:
            scratch = Mock(container="scratch")
            self.assertEqual(CHECK.all_data(scratch, "db", True), "raw non-seed data[]")
            for table in CHECK.SEEDS:
                self.assertIn(f"--exclude-table-data={table}", run.call_args.args)
            seeds.assert_called_once_with(scratch, "db")
            seeds.reset_mock()
            self.assertEqual(CHECK.all_data(scratch, "db"), "raw non-seed data")
            self.assertFalse(any(arg.startswith("--exclude-table-data=") for arg in run.call_args.args))
            seeds.assert_not_called()


class RecordedLedgerTests(unittest.TestCase):
    def test_checks_every_post_cut_apply_and_skip_message(self):
        files = [pathlib.Path("0216_repair.sql"), pathlib.Path("0217_schema.sql"),
                 pathlib.Path("0218_schema.sql")]
        for missing in (None, files[1], files[2]):
            for environment in ("dev", "prod"):
                with self.subTest(missing=missing, environment=environment), contextlib.ExitStack() as stack:
                    stack.enter_context(patch.object(CHECK, "post_cut_files", return_value=files))
                    stack.enter_context(patch.object(CHECK, "replay"))
                    stack.enter_context(patch.object(CHECK, "snapshot", return_value="unchanged"))
                    error = subprocess.CalledProcessError(
                        1, "runner", stderr="Historical checksum mismatch: 0001_seed.sql")
                    stack.enter_context(patch.object(CHECK, "migrate", side_effect=error))
                    def output(scratch, db):
                        status = "already applied" if db == "recorded_dev" else "applying..."
                        return "\n".join(f"{file.name} — {status}" for file in files
                                         if file != missing or db != f"recorded_{environment}")
                    stack.enter_context(patch.object(CHECK, "verify_adoption", side_effect=output))
                    if missing is None:
                        CHECK.recorded_ledger_checks(Mock())
                    else:
                        with self.assertRaisesRegex(RuntimeError, missing.name):
                            CHECK.recorded_ledger_checks(Mock())


if __name__ == "__main__":
    unittest.main()
