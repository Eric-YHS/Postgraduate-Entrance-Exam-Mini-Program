"""隔离的服务端契约测试。

这些测试只导入 server.py 的函数或在本机回环临时端口启动真实 HTTP 服务；
每次测试使用独立临时目录，不读写项目 data/，也不访问外部服务。
测试故意不把当前缺陷变成 skip：失败即表示实现尚未满足目标契约。
"""
from __future__ import annotations

import importlib.util
import json
import os
import shutil
import sqlite3
import tempfile
import threading
import time
import types
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from unittest.mock import patch


PROJECT_ROOT = Path(__file__).resolve().parents[1]


class ContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.original_env = os.environ.copy()
        cls.data_dir = Path(tempfile.mkdtemp(prefix="yanban-contract-root-"))
        # server.py reads these values at import time. Do not use the checked-in
        # data directory or any configured provider credentials in this suite.
        os.environ["YANBAN_DATA_DIR"] = str(cls.data_dir)
        os.environ.pop("YANBAN_LOCAL_TEST_MODE", None)
        os.environ.pop("YANBAN_LLM_BASE_URL", None)
        os.environ.pop("YANBAN_LLM_API_KEY", None)
        os.environ.pop("YANBAN_LLM_MODEL", None)
        os.environ.pop("YANBAN_VISION_BASE_URL", None)
        os.environ.pop("YANBAN_VISION_API_KEY", None)
        os.environ.pop("YANBAN_VISION_MODEL", None)
        os.environ.pop("TAVILY_API_KEY", None)
        spec = importlib.util.spec_from_file_location("yanban_contract_server", PROJECT_ROOT / "server.py")
        cls.server = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(cls.server)
        # load_env_file may discover a checked-in developer .env; remove it
        # from this process so no provider credential can affect the suite.
        os.environ.pop("TAVILY_API_KEY", None)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.data_dir, ignore_errors=True)
        current_keys = set(os.environ)
        for key in current_keys - set(cls.original_env):
            os.environ.pop(key, None)
        os.environ.update(cls.original_env)

    def setUp(self):
        self.s = self.server
        # Use a fresh directory for every test. This also avoids Windows file
        # locking around SQLite WAL sidecars when tests run in one process.
        self.test_data_dir = Path(tempfile.mkdtemp(prefix="yanban-contract-"))
        self.s.DATA_DIR = self.test_data_dir.resolve()
        self.s.UPLOAD_DIR = self.s.DATA_DIR / "uploads"
        self.s.INDEX_PATH = self.s.DATA_DIR / "document_index.json"
        self.s.DATABASE_PATH = self.s.DATA_DIR / "yanban.sqlite3"
        self.s.DATABASE_INITIALIZED = False

    def tearDown(self):
        shutil.rmtree(self.test_data_dir, ignore_errors=True)

    def _student(self, student_id, phone):
        self.s.ensure_data_dirs()
        return self.s.create_student_account({
            "studentId": student_id,
            "phone": phone,
            "password": "correct horse battery",
            "displayName": student_id,
        }, teacher=True)

    def _write_index(self, documents):
        self.s.ensure_data_dirs()
        self.s.write_index({"documents": {item["id"]: item for item in documents}})

    def test_initialize_database_creates_isolated_schema_and_uploads(self):
        self.s.ensure_data_dirs()
        self.assertTrue(self.s.DATABASE_PATH.is_file())
        self.assertTrue(self.s.UPLOAD_DIR.is_dir())
        self.assertTrue(self.s.INDEX_PATH.is_file())
        with self.s.open_database() as connection:
            tables = {
                row["name"] for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                )
            }
        self.assertTrue({"students", "student_accounts", "student_sessions", "paper_material_packages"} <= tables)
        self.assertEqual(self.s.DATA_DIR, self.test_data_dir.resolve())

    def test_production_mode_is_fail_closed_when_switch_is_missing(self):
        os.environ.pop("YANBAN_LOCAL_TEST_MODE", None)
        self.assertTrue(
            self.s.production_mode(),
            "未明确开启本地测试时必须按生产模式处理，避免默认开放匿名业务接口",
        )
        os.environ["YANBAN_LOCAL_TEST_MODE"] = "0"
        self.assertTrue(self.s.production_mode())
        os.environ["YANBAN_LOCAL_TEST_MODE"] = "1"
        self.assertFalse(self.s.production_mode())

    def test_disabled_account_invalidates_existing_session(self):
        student_id = "student-disabled-01"
        self._student(student_id, "13800000001")
        login = self.s.student_login({"phone": "13800000001", "password": "correct horse battery"})
        token = login["sessionToken"]
        with self.s.open_database() as connection:
            connection.execute(
                "UPDATE student_accounts SET status='disabled' WHERE student_id=?", (student_id,)
            )

        class Handler:
            headers = {"Authorization": f"Bearer {token}"}

        with self.assertRaises(
            self.s.AccountDisabledError,
            msg="账号停用后原有 token 必须立即失效并返回稳定的 account_disabled 语义",
        ):
            self.s.session_student_id(Handler())

    def test_material_analysis_rejects_document_of_another_owner(self):
        owner = "student-owner-01"
        intruder = "student-intruder-01"
        self._student(owner, "13800000002")
        self._student(intruder, "13800000003")
        self._write_index([{
            "id": "doc-owner-01", "name": "owner.txt", "kind": "text",
            "studentId": owner, "courseName": "政治", "chunks": [{"chunkId": "chunk-1", "text": "仅属于 owner"}],
        }])
        # A caller requesting an explicitly unauthorized document must receive
        # a denial, rather than an empty result that hides the violation.
        with self.assertRaises(PermissionError):
            self.s.resolve_student_documents(intruder, ["doc-owner-01"], "政治")

    def test_approved_shared_document_is_visible_only_to_matching_student(self):
        owner = "student-share-owner"
        peer = "student-share-peer"
        outsider = "student-share-out"
        self._student(owner, "13800000011")
        self._student(peer, "13800000012")
        self._student(outsider, "13800000013")
        self.s.upsert_course_entitlement(owner, "course-1", "政治", "active", "test")
        self.s.upsert_course_entitlement(peer, "course-1", "政治", "active", "test")
        self.s.upsert_course_entitlement(outsider, "course-1", "英语", "active", "test")
        for student_id, school, major, course in ((owner, "同一大学", "政治学", "政治"), (peer, "同一大学", "政治学", "政治"), (outsider, "另一大学", "英语", "英语")):
            self.s.update_student_profile({"studentId": student_id, "displayName": student_id, "targetSchool": school, "targetMajor": major, "targetCourse": course})
        document = {"id": "doc-share001", "name": "共享.txt", "kind": "text", "studentId": owner, "courseKey": "course-1", "courseName": "政治", "targetSchool": "同一大学", "targetMajor": "政治学", "subjectCode": "333", "status": "parsed", "sharingStatus": "private", "chunks": [{"chunkId": "chunk-share", "text": "仅匹配学生可见"}]}
        self._write_index([document])
        self.s.sync_material_library(document)
        with self.assertRaises(PermissionError):
            self.s.resolve_student_documents(peer, [document["id"]], "course-1", require_parsed=True)
        self.s.update_document_sharing_status(document["id"], "approved_shared")
        self.assertEqual(self.s.resolve_student_documents(peer, [document["id"]], "course-1", require_parsed=True)[0]["id"], document["id"])
        with self.assertRaises(PermissionError):
            self.s.resolve_student_documents(outsider, [document["id"]], "course-1", require_parsed=True)

    def test_student_payload_cannot_switch_authenticated_owner(self):
        student_id = "student-owner-guard"
        other_id = "student-other-guard"
        self._student(student_id, "13800000014")
        self._student(other_id, "13800000015")
        login = self.s.student_login({"phone": "13800000014", "password": "correct horse battery"})

        class Handler:
            headers = {"Authorization": f"Bearer {login['sessionToken']}"}

        handler = Handler()
        with patch.dict(os.environ, {"YANBAN_LOCAL_TEST_MODE": "0"}):
            with self.assertRaises(PermissionError):
                self.s.ApiHandler.require_student_payload(handler, {"studentId": other_id})
            self.assertEqual(self.s.ApiHandler.require_student_payload(handler, {"studentId": student_id})["studentId"], student_id)

    def test_material_analysis_rejects_document_from_another_course(self):
        owner = "student-course-01"
        self._student(owner, "13800000004")
        self._write_index([{
            "id": "doc-course-01", "name": "英语.txt", "kind": "text",
            "studentId": owner, "courseName": "英语", "status": "parsed",
            "chunks": [{"chunkId": "chunk-1", "text": "英语内容"}],
        }])
        # Resolve the exact document IDs through the same authorization helper
        # used by analysis routes. A course mismatch must be a denial, not an
        # empty list or a model request with unrelated material.
        with self.assertRaises(PermissionError):
            self.s.resolve_student_documents(owner, ["doc-course-01"], "政治", require_parsed=True)

    def test_course_workspaces_are_isolated(self):
        student_id = "student-scope-01"
        self._student(student_id, "13800000005")
        now = self.s.utc_now()
        self.s.upsert_course_entitlement(student_id, "course-1", "政治", "active", "test")
        self.s.upsert_course_entitlement(student_id, "course-2", "英语", "active", "test")
        self.s.update_student_workspace({"studentId": student_id, "courseKey": "course-1", "workspace": {"subject": "政治", "documentIds": []}})
        self.s.update_student_workspace({"studentId": student_id, "courseKey": "course-2", "workspace": {"subject": "英语", "documentIds": []}})
        self.assertEqual(self.s.student_workspace(student_id, "course-1")["workspace"]["subject"], "政治")
        self.assertEqual(self.s.student_workspace(student_id, "course-2")["workspace"]["subject"], "英语")
        with self.s.open_database() as connection:
            rows = connection.execute("SELECT course_key FROM student_course_workspaces WHERE student_id=? ORDER BY course_key", (student_id,)).fetchall()
        self.assertEqual([row["course_key"] for row in rows], ["course-1", "course-2"])

    def test_recite_feedback_requires_queue_and_updates_review_fields(self):
        student_id = "student-recite-01"
        self._student(student_id, "13800000006")
        self.s.upsert_course_entitlement(student_id, "course-1", "政治", "active", "test")
        now = self.s.utc_now()
        with self.s.open_database() as connection:
            connection.execute("INSERT INTO recite_items(id, student_id, course_key, prompt, answer, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", ("recite-test-01", student_id, "course-1", "问题", "答案", now, now))
        self.s.build_daily_snapshot(student_id, "course-1")
        self.s.mark_recite_item_done(student_id, "course-1", "recite-test-01", result="wrong", actual_minutes=3, phase="feedback", recall_text="部分答案")
        with self.s.open_database() as connection:
            row = connection.execute("SELECT fail_count, next_review_at, last_actual_minutes, last_phase, last_recall_text FROM recite_items WHERE id=?", ("recite-test-01",)).fetchone()
        self.assertEqual(row["fail_count"], 1)
        self.assertTrue(row["next_review_at"])
        self.assertEqual(row["last_actual_minutes"], 3)
        self.assertEqual(row["last_phase"], "feedback")
        self.assertEqual(row["last_recall_text"], "部分答案")
        with self.assertRaises(PermissionError):
            self.s.mark_recite_item_done(student_id, "course-1", "recite-not-in-queue", result="forgot")

    def test_subjective_answer_without_model_has_no_fixed_score(self):
        item = {
            "question_type": "short_answer", "stem": "说明原因", "reference_answer": "依据资料",
            "rubric": ["要点"], "options": [],
        }
        unavailable = {
            "enabled": True, "modelConfigured": False, "modelId": "",
            "prompt": "", "constraints": "",
        }
        with patch.object(self.s, "practice_robot_settings", return_value=unavailable):
            result = self.s.evaluate_practice_answer(item, "我的回答")
        self.assertEqual(result["errorType"], "model_unavailable")
        self.assertIsNone(
            result["score"],
            "没有主观题评分模型时只能返回不可评分状态，不能制造固定分数",
        )

    def test_print_render_serializes_dictionary_chunks(self):
        student_id = "student-print-01"
        self.s.upsert_student(student_id, "打印测试")
        package_id = self.s.upsert_paper_material_package(student_id, "政治", "政治")
        self._write_index([{
            "id": "doc-print-01", "name": "试题.txt", "kind": "exam",
            "studentId": student_id, "courseName": "政治",
            "chunks": [{"chunkId": "chunk-1", "text": "字典形式的可打印内容"}],
        }])
        rendered = self.s.render_paper_material_html(package_id)
        self.assertIn("字典形式的可打印内容", rendered)

    def test_upload_type_checks_reject_mismatched_mime_and_magic_bytes(self):
        with self.assertRaises(ValueError):
            self.s.validate_uploaded_file("notes.pdf", b"plain text", "text/plain")
        with self.assertRaises(ValueError):
            self.s.validate_uploaded_file("notes.png", b"not an image", "image/png")
        suffix, mime = self.s.validate_uploaded_file("notes.txt", b"plain text", "text/plain")
        self.assertEqual(suffix, ".txt")
        self.assertEqual(mime, "text/plain")

    def test_parse_retry_keeps_original_input_and_records_failure(self):
        student_id = "student-retry-01"
        self._student(student_id, "13800000007")
        self.s.upsert_course_entitlement(student_id, "course-1", "政治", "active", "test")
        self.s.ensure_data_dirs()
        document_id = "doc-retry001"
        filename = "retry.txt"
        (self.s.UPLOAD_DIR / f"{document_id}-{filename}").write_text("原始资料内容", encoding="utf-8")
        self._write_index([{"id": document_id, "name": filename, "studentId": student_id, "courseKey": "course-1", "courseName": "政治", "status": "parse_failed", "parseError": "首次失败", "chunks": []}])
        with patch.object(self.s, "extract_text", side_effect=RuntimeError("解析器暂时不可用")):
            result = self.s.retry_document_parse(student_id, document_id, "course-1")
        self.assertEqual(result["document"]["status"], "parse_failed")
        self.assertGreaterEqual(result["document"]["parseAttempts"], 1)
        self.assertEqual((self.s.UPLOAD_DIR / f"{document_id}-{filename}").read_text(encoding="utf-8"), "原始资料内容")

    def test_plan_never_exceeds_declared_daily_minutes(self):
        student_id = "student-budget-01"
        self._student(student_id, "13800000008")
        self.s.upsert_course_entitlement(student_id, "course-1", "政治", "active", "test")
        result = self.s.build_plan({"studentId": student_id, "courseKey": "course-1", "subject": "政治", "todayMinutes": 10, "planningDays": 7})
        self.assertLessEqual(result["effectiveMinutes"], 10)
        for day in result["daysPlan"]:
            self.assertLessEqual(sum(int(task.get("minutes") or 0) for task in day.get("tasks", [])), 10)

    def test_notification_read_is_course_scoped(self):
        student_id = "student-notice-01"
        self._student(student_id, "13800000009")
        self.s.upsert_course_entitlement(student_id, "course-1", "政治", "active", "test")
        self.s.upsert_course_entitlement(student_id, "course-2", "英语", "active", "test")
        with self.s.open_database() as connection:
            connection.execute("INSERT INTO student_notifications(id, student_id, kind, message, document_id, course_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", ("notice-course-2", student_id, "test", "英语通知", "", "course-2", self.s.utc_now()))
        self.assertEqual(self.s.student_notifications(student_id, course_key="course-1")["notifications"], [])
        with self.assertRaises(ValueError):
            self.s.mark_student_notification_read(student_id, "notice-course-2", "course-1")
        self.assertEqual(self.s.mark_student_notification_read(student_id, "notice-course-2", "course-2")["ok"], True)


    def test_analysis_blocks_split_and_bind_sources_code_side(self):
        # 分块由固定算法完成，来源（docId/chunkIds）由代码侧绑定，模型不参与引用。
        big = "波动光学内容。" * 2000  # 每块约 1.2 万字符
        documents = [
            {"docId": "doc-a", "chunks": [{"chunkId": "a-1", "text": big}, {"chunkId": "a-2", "text": big}]},
            {"docId": "doc-b", "chunks": [{"chunkId": "b-1", "text": "相干条件"}]},
        ]
        blocks = self.s._analysis_blocks(documents)
        self.assertEqual(len(blocks), 3, "两块大料各成一块，小料合成一块")
        self.assertEqual(blocks[0]["docIds"], ["doc-a"])
        self.assertEqual(blocks[0]["chunkIds"], ["a-1"])
        self.assertEqual(blocks[2]["docIds"], ["doc-b"])
        self.assertTrue(all(block["text"].strip() for block in blocks))

    def test_run_block_analysis_parallel_assembly(self):
        student_id = "student-block-01"
        self._student(student_id, "13800000052")
        run_id = "analysis-test-block01"
        with self.s.open_database() as connection:
            connection.execute(
                "INSERT INTO course_analysis_runs(id, student_id, course_key, course_name, status, source_doc_ids_json, created_at) VALUES (?, ?, 'course-1', '物理光学', 'running', '[]', ?)",
                (run_id, student_id, self.s.utc_now()),
            )
        documents = [{"docId": "doc-x", "chunks": [{"chunkId": "x-1", "text": "光的干涉定义与相干条件"}]}]

        def fake_call_model(system, prompt, role="text", model_id=None):
            if "资料片段" in prompt:
                return {
                    "knowledgeEntries": [{"title": "光的干涉", "summary": "两列波叠加", "detail": "相干条件：同频、同向、恒定相位差", "chapter": "波动光学"}],
                    "reciteItems": [{"prompt": "相干条件是什么", "answer": "同频同向恒定相位差"}],
                    "practiceItems": [{"stem": "简述相干条件", "questionType": "short_answer", "referenceAnswer": "同频同向恒定相位差"}],
                }
            return {"courseAttribute": "science", "courseFocus": "波动光学", "coverage": {"coveredTopics": ["干涉"]}, "focus": {"highPriorityTopics": ["干涉"]}, "warnings": []}

        with patch.object(self.s, "call_model", side_effect=fake_call_model):
            normalized = self.s.run_block_analysis("物理光学", {"school": "中山大学"}, documents, {}, {"prompt": "", "constraints": "", "modelId": None}, run_id)
        self.assertEqual(normalized["knowledgeEntries"][0]["sourceDocumentIds"], ["doc-x"], "来源必须由代码侧绑定")
        self.assertEqual(normalized["knowledgeEntries"][0]["sourceChunkIds"], ["x-1"])
        self.assertEqual(normalized["courseAttribute"], "science")
        self.assertEqual(normalized["stats"]["blocks"], 1)
        with self.s.open_database() as connection:
            stats = json.loads(connection.execute("SELECT stats_json FROM course_analysis_runs WHERE id=?", (run_id,)).fetchone()["stats_json"])
        self.assertEqual(stats.get("stage"), "入库", "进度必须写入 run 记录供前端显示")

    def test_run_block_analysis_fails_loudly_when_block_fails(self):
        student_id = "student-block-02"
        self._student(student_id, "13800000053")
        run_id = "analysis-test-block02"
        with self.s.open_database() as connection:
            connection.execute(
                "INSERT INTO course_analysis_runs(id, student_id, course_key, course_name, status, source_doc_ids_json, created_at) VALUES (?, ?, 'course-1', '物理光学', 'running', '[]', ?)",
                (run_id, student_id, self.s.utc_now()),
            )
        documents = [{"docId": "doc-y", "chunks": [{"chunkId": "y-1", "text": "内容"}]}]
        with patch.object(self.s, "call_model", side_effect=RuntimeError("模型服务不可用")), patch.object(self.s.time, "sleep", lambda *_: None):
            with self.assertRaises(RuntimeError, msg="任一块失败必须整轮失败，不得产出半份结果"):
                self.s.run_block_analysis("物理光学", {}, documents, {}, {"prompt": "", "constraints": "", "modelId": None}, run_id)

    def test_sanitize_portrait_wording(self):
        cleaned = self.s.sanitize_portrait_wording({
            "features": ["双一流高校（预估）", "师范特色（预估（待官方核验））"],
            "note": "考试安排以教育部公告为准，分数线预估340分。",
            "nested": [{"text": "难度以官方公布为准"}],
        })
        self.assertEqual(cleaned["features"], ["双一流高校", "师范特色"])
        self.assertNotIn("预估", cleaned["note"])
        self.assertNotIn("为准", cleaned["note"])
        self.assertNotIn("为准", cleaned["nested"][0]["text"])

    def test_analyze_center_async_dedupes_in_flight(self):
        student_id = "student-async-01"
        self._student(student_id, "13800000054")
        calls = []

        def slow_analysis(payload):
            calls.append(payload)
            time.sleep(0.3)

        with patch.object(self.s, "analyze_course_center", side_effect=slow_analysis):
            first = self.s.analyze_course_center_async({"studentId": student_id, "courseKey": "course-1", "subject": "政治"})
            second = self.s.analyze_course_center_async({"studentId": student_id, "courseKey": "course-1", "subject": "政治"})
            self.assertEqual(first["status"], "running")
            self.assertEqual(second["status"], "running")
            time.sleep(0.6)
        self.assertEqual(len(calls), 1, "进行中的分析不得重复启动")

    def test_failed_analysis_run_keeps_previous_active_items(self):
        student_id = "student-staging-01"
        self._student(student_id, "13800000010")
        self.s.upsert_course_entitlement(student_id, "course-1", "政治", "active", "test")
        self._write_index([{"id": "doc-stage01", "name": "stage.txt", "kind": "text", "studentId": student_id, "courseKey": "course-1", "courseName": "政治", "status": "parsed", "chunks": [{"chunkId": "chunk-stage", "text": "既有资料"}]}])
        now = self.s.utc_now()
        with self.s.open_database() as connection:
            connection.execute("INSERT INTO recite_items(id, student_id, course_key, prompt, answer, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'new', ?, ?)", ("recite-old01", student_id, "course-1", "旧卡片", "旧答案", now, now))
        with patch.object(self.s, "build_course_exam_research", return_value={"status": "not_available", "sources": []}), patch.object(self.s, "analyze_course_exam_evidence", side_effect=lambda target, course, research: research), patch.object(self.s, "model_configured", return_value=True), patch.object(self.s, "call_model", side_effect=RuntimeError("provider=https://private.example/v1 api_key=secret-key")):
            with self.assertRaises(RuntimeError):
                self.s.analyze_course_center({"studentId": student_id, "courseKey": "course-1", "subject": "政治", "target": {"school": "示例大学", "major": "政治学"}})
        with self.s.open_database() as connection:
            run = connection.execute("SELECT status, error FROM course_analysis_runs WHERE student_id=? ORDER BY created_at DESC LIMIT 1", (student_id,)).fetchone()
            old = connection.execute("SELECT status FROM recite_items WHERE id=?", ("recite-old01",)).fetchone()
        self.assertEqual(run["status"], "failed")
        self.assertNotIn("secret-key", run["error"])
        self.assertEqual(old["status"], "new")

    def test_error_response_does_not_expose_internal_configuration(self):
        captured = {}

        class Handler:
            def send_json(self, status, payload):
                captured["status"] = status
                captured["payload"] = payload

        @self.s.api_get_error_boundary
        def failing_handler(_handler):
            raise RuntimeError("provider=https://internal.example/v1 api_key=super-secret-key path=C:/private/data")

        failing_handler(Handler())
        body = json.dumps(captured["payload"], ensure_ascii=False)
        self.assertEqual(captured["status"], self.s.HTTPStatus.SERVICE_UNAVAILABLE)
        self.assertNotIn("super-secret-key", body)
        self.assertNotIn("internal.example", body)
        self.assertNotIn("C:/private/data", body)
        self.assertIn("service_unavailable", body)

    def test_reject_course_request_requires_reason_and_returns_it(self):
        student_id = "student-reject-01"
        self._student(student_id, "13800000021")
        with self.assertRaises(ValueError, msg="驳回必须填写原因，不能只留下无解释的 rejected 状态"):
            self.s.update_base_course_access({"studentId": student_id, "baseCourseEnabled": False})
        self.s.update_base_course_access({"studentId": student_id, "baseCourseEnabled": False, "reason": "请补充目标院校全称和专业课代码。"})
        access = self.s.student_course_access(student_id)
        self.assertEqual(access["requestStatus"], "rejected")
        self.assertEqual(access["requestReason"], "请补充目标院校全称和专业课代码。")
        self.s.update_base_course_access({"studentId": student_id, "baseCourseEnabled": True})
        self.assertEqual(self.s.student_course_access(student_id)["requestReason"], "")

    def test_capability_assessment_requires_entitlement_and_is_course_scoped(self):
        student_id = "student-cap-01"
        self._student(student_id, "13800000022")
        self.s.upsert_student(student_id, "能力画像测试")
        self.s.upsert_course_entitlement(student_id, "course-1", "政治", "active", "test")
        self.s.upsert_course_entitlement(student_id, "course-2", "英语", "active", "test")
        payload = {"studentId": student_id, "courseName": "政治", "dailyMinutes": 60, "knowledge": "刚看完导论"}
        with self.assertRaises(PermissionError, msg="未授权课程不能保存能力评价"):
            self.s.save_student_capability_assessment({**payload, "courseKey": "course-9"})
        self.s.save_student_capability_assessment({**payload, "courseKey": "course-1"})
        course_one = self.s.student_capability_portrait(student_id, "course-1")["entries"]
        self.assertEqual(len(course_one), 1)
        self.assertEqual(course_one[0]["courseKey"], "course-1")
        self.assertEqual(self.s.student_capability_portrait(student_id, "course-2")["entries"], [])

    def test_document_scope_conflict_rejected_when_entitlement_scope_present(self):
        student_id = "student-scope-02"
        self._student(student_id, "13800000023")
        self.s.upsert_course_entitlement(student_id, "course-1", "政治", "active", "test", scope={"school": "A大学", "college": "商学院", "major": "政治学"})
        self._write_index([{
            "id": "doc-scope-01", "name": "他校资料.txt", "kind": "text",
            "studentId": student_id, "courseKey": "course-1", "courseName": "政治",
            "targetSchool": "B大学", "targetCollege": "商学院", "targetMajor": "政治学",
            "status": "parsed", "chunks": [{"chunkId": "chunk-1", "text": "其他院校的资料"}],
        }])
        with self.assertRaises(PermissionError, msg="院校冲突的资料不得进入当前课程空间"):
            self.s.resolve_student_documents(student_id, ["doc-scope-01"], "course-1", require_parsed=True)

    def test_deleted_document_marks_analysis_run_stale(self):
        student_id = "student-stale-01"
        self._student(student_id, "13800000024")
        self.s.upsert_course_entitlement(student_id, "course-1", "政治", "active", "test")
        document = {"id": "doc-stale0001", "name": "stale.txt", "kind": "text", "studentId": student_id, "courseKey": "course-1", "courseName": "政治", "status": "parsed", "chunks": [{"chunkId": "chunk-1", "text": "会被删除的资料"}]}
        self._write_index([document])
        now = self.s.utc_now()
        with self.s.open_database() as connection:
            connection.execute(
                "INSERT INTO course_analysis_runs(id, student_id, course_key, course_name, status, source_doc_ids_json, summary_json, stats_json, created_at, completed_at) VALUES (?, ?, ?, ?, 'completed', ?, '{}', '{}', ?, ?)",
                ("run-stale-01", student_id, "course-1", "政治", json.dumps([document["id"]]), now, now),
            )
        self.s.delete_student_document(student_id, document["id"], "course-1")
        latest = self.s.knowledge_base_summary(student_id, "course-1")["latestRun"]
        self.assertTrue(latest["stale"], "删除已引用资料后，历史分析必须显示过期而不是继续冒充可用结果")
        self.assertEqual(latest["staleDocumentIds"], [document["id"]])

    def test_delete_student_writes_audit_event(self):
        student_id = "student-audit-01"
        self._student(student_id, "13800000025")
        self.s.delete_student_profile(student_id)
        with self.s.open_database() as connection:
            row = connection.execute(
                "SELECT actor_type, action, target_id FROM audit_log WHERE action='student_deleted' AND target_id=?",
                (student_id,),
            ).fetchone()
        self.assertIsNotNone(row, "删除学生必须写入审计事件")
        self.assertEqual(row["actor_type"], "admin")

    def test_delete_student_with_entitlements_and_sessions_succeeds(self):
        student_id = "student-del-fk-01"
        self._student(student_id, "13800000044")
        self.s.upsert_course_entitlement(student_id, "course-1", "政治", "active", "test")
        token = self.s.student_login({"phone": "13800000044", "password": "correct horse battery"})["sessionToken"]
        result = self.s.delete_student_profile(student_id)
        self.assertTrue(result["ok"], "带 entitlement 与会话的学生必须能完整删除")
        with self.s.open_database() as connection:
            leftover = connection.execute("SELECT 1 FROM student_course_entitlements WHERE student_id=?", (student_id,)).fetchone()
            deleted = connection.execute("SELECT 1 FROM deleted_students WHERE student_id=?", (student_id,)).fetchone()
        self.assertIsNone(leftover, "删除后不得残留 entitlement 行")
        self.assertIsNotNone(deleted)
        with self.assertRaises(self.s.StudentDeletedError, msg="删除后原身份必须立即失效"):
            self.s.ensure_student_active(student_id)

    def test_admin_loop_overview_covers_unentitled_students(self):
        entitled_id, plain_id = "student-loop-01", "student-loop-02"
        self._student(entitled_id, "13800000045")
        self._student(plain_id, "13800000046")
        self.s.upsert_course_entitlement(entitled_id, "course-1", "政治", "active", "test")
        rows = self.s.admin_loop_overview()
        by_id = {row["studentId"]: row for row in rows}
        self.assertIn(entitled_id, by_id)
        self.assertIn(plain_id, by_id, "未开通课程的学生也必须出现在管理端聚合视图")
        self.assertTrue(by_id[entitled_id]["courseEntitled"])
        self.assertFalse(by_id[plain_id]["courseEntitled"], "未开通课程的学生应标记 courseEntitled=False 而不是整页 403")
        self.assertEqual(by_id[plain_id]["reciteTotal"], 0)

    def test_mindmap_structure_normalizes_instead_of_rejecting(self):
        valid = {
            "nodes": [
                {"id": "root", "label": "根", "type": "root", "confidence": "confirmed", "sourceChunkIds": ["c1"]},
                {"id": "n1", "label": "分支", "type": "topic", "confidence": "medium"},
            ],
            "edges": [{"source": "root", "target": "n1", "relation": "包含"}],
        }
        self.assertIs(self.s.validate_mindmap_structure(valid), valid)
        # 无根节点（环状结构无入度为 0 的节点）：补根并把所有顶层节点挂回，不再整图判死
        repaired = self.s.validate_mindmap_structure({"nodes": [{"id": "a", "type": "topic"}, {"id": "b", "type": "topic"}], "edges": [{"source": "a", "target": "b"}, {"source": "b", "target": "a"}]})
        roots = [n for n in repaired["nodes"] if n.get("type") == "root"]
        self.assertEqual(len(roots), 1, "缺根时必须合成一个根节点")
        targets = {edge["target"] for edge in repaired["edges"]}
        self.assertIn("a", targets)
        self.assertIn("b", targets)
        # 悬空边直接丢弃而不是报错
        cleaned = self.s.validate_mindmap_structure({"nodes": [{"id": "root", "type": "root"}], "edges": [{"source": "root", "target": "ghost"}]})
        self.assertEqual(cleaned["edges"], [], "指向不存在节点的边必须被剔除")
        # 孤立节点挂回根
        attached = self.s.validate_mindmap_structure({"nodes": [{"id": "root", "type": "root"}, {"id": "n1", "type": "topic"}, {"id": "n2", "type": "topic"}], "edges": [{"source": "root", "target": "n1"}]})
        self.assertIn("n2", {edge["target"] for edge in attached["edges"]}, "孤立节点必须挂回根")
        # 空节点才真正失败
        with self.assertRaises(RuntimeError):
            self.s.validate_mindmap_structure({"nodes": [], "edges": []})

    def test_plan_reserves_buffer_and_surfaces_unverified_exam_date(self):
        student_id = "student-buffer-01"
        self._student(student_id, "13800000026")
        self.s.upsert_course_entitlement(student_id, "course-1", "政治", "active", "test")
        now = self.s.utc_now()
        with self.s.open_database() as connection:
            for index in range(6):
                connection.execute("INSERT INTO recite_items(id, student_id, course_key, prompt, answer, estimate_seconds, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 600, 'new', ?, ?)", (f"recite-buf-{index:02d}", student_id, "course-1", f"知识点{index}", "答案", now, now))
        result = self.s.build_plan({"studentId": student_id, "courseKey": "course-1", "subject": "政治", "todayMinutes": 100, "planningDays": 7})
        self.assertGreaterEqual(result["bufferMinutes"], 10, "计划必须预留 10%-15% 缓冲")
        for day in result["daysPlan"]:
            self.assertLessEqual(sum(int(task.get("minutes") or 0) for task in day.get("tasks", [])), 100 - result["bufferMinutes"] + 5)
        self.assertEqual(result["examSchedule"]["status"], "pending_verification", "未核验的考试日期不得显示为精确倒计时")

    def test_task_plan_robot_disabled_by_default_keeps_deterministic_plan(self):
        student_id = "student-taskplan-01"
        self._student(student_id, "13800000070")
        self.s.upsert_course_entitlement(student_id, "course-1", "政治", "active", "test")
        result = self.s.build_plan({"studentId": student_id, "courseKey": "course-1", "subject": "政治", "todayMinutes": 120, "planningDays": 7})
        self.assertEqual(result["taskPlanRobot"]["status"], "disabled", "任务管理机器人默认停用")
        self.assertNotIn("robotPlanSummary", result)
        self.assertTrue(any(day.get("tasks") for day in result["daysPlan"]), "确定性计划必须照常生成")
        for day in result["daysPlan"]:
            self.assertNotIn("robotNote", day, "停用状态下不得伪造机器人提示")

    def test_task_plan_robot_enabled_without_model_reports_not_configured(self):
        student_id = "student-taskplan-02"
        self._student(student_id, "13800000071")
        self.s.upsert_course_entitlement(student_id, "course-1", "政治", "active", "test")
        self.s.update_admin_settings({"taskPlanRobotEnabled": True})
        result = self.s.build_plan({"studentId": student_id, "courseKey": "course-1", "subject": "政治", "todayMinutes": 120, "planningDays": 7})
        self.assertEqual(result["taskPlanRobot"]["status"], "not_configured", "启用但未配置模型时必须如实上报")
        self.assertNotIn("robotPlanSummary", result)
        self.assertTrue(any(day.get("tasks") for day in result["daysPlan"]), "未配置模型时计划仍为确定性结果")
        for day in result["daysPlan"]:
            self.assertNotIn("robotNote", day, "模型未配置时不得伪造机器人输出")

    def test_task_plan_robot_admin_fields_roundtrip(self):
        now = self.s.utc_now()
        self.s.ensure_data_dirs()
        with self.s.open_database() as connection:
            connection.execute(
                "INSERT INTO configured_models(id, capability, display_name, base_url, api_key, upstream_model, input_cost_per_million, output_cost_per_million, enabled, created_at, updated_at) VALUES (?, 'text', '测试文本模型', 'http://127.0.0.1:9/v1', 'sk-test', 'fake-model', 0, 0, 1, ?, ?)",
                ("model-task-plan-1", now, now),
            )
        result = self.s.update_admin_settings({
            "taskPlanRobotEnabled": True,
            "taskPlanRobotPrompt": "把确定性排程转写为学生能执行的一句话任务说明。",
            "taskPlanRobotConstraints": "只输出合法 JSON，不编造考试事实。",
            "taskPlanRobotModelId": "model-task-plan-1",
        })
        self.assertEqual(result["taskPlanRobot"]["enabled"], True)
        self.assertEqual(result["taskPlanRobot"]["prompt"], "把确定性排程转写为学生能执行的一句话任务说明。")
        self.assertEqual(result["taskPlanRobot"]["constraints"], "只输出合法 JSON，不编造考试事实。")
        self.assertEqual(result["taskPlanRobot"]["modelId"], "model-task-plan-1")
        reloaded = self.s.admin_settings()["taskPlanRobot"]
        self.assertEqual(reloaded["enabled"], True)
        self.assertEqual(reloaded["modelId"], "model-task-plan-1", "模型绑定必须持久化")

    def test_task_plan_robot_model_failure_falls_back_to_deterministic_plan(self):
        student_id = "student-taskplan-03"
        self._student(student_id, "13800000072")
        self.s.upsert_course_entitlement(student_id, "course-1", "政治", "active", "test")
        now = self.s.utc_now()
        with self.s.open_database() as connection:
            connection.execute(
                "INSERT INTO configured_models(id, capability, display_name, base_url, api_key, upstream_model, input_cost_per_million, output_cost_per_million, enabled, created_at, updated_at) VALUES (?, 'text', '不可达模型', 'http://127.0.0.1:9/v1', 'sk-test', 'fake-model', 0, 0, 1, ?, ?)",
                ("model-task-plan-dead", now, now),
            )
        self.s.update_admin_settings({"taskPlanRobotEnabled": True, "taskPlanRobotModelId": "model-task-plan-dead"})
        result = self.s.build_plan({"studentId": student_id, "courseKey": "course-1", "subject": "政治", "todayMinutes": 120, "planningDays": 7})
        self.assertEqual(result["taskPlanRobot"]["status"], "failed", "模型异常必须如实上报并静默回退")
        self.assertNotIn("robotPlanSummary", result)
        self.assertTrue(any(day.get("tasks") for day in result["daysPlan"]), "模型失败时确定性计划不得丢失")
        for day in result["daysPlan"]:
            self.assertNotIn("robotNote", day, "模型失败时不得残留机器人输出")

    def test_plan_task_progress_rejects_foreign_task_id(self):
        student_id = "student-taskguard-01"
        self._student(student_id, "13800000027")
        self.s.upsert_course_entitlement(student_id, "course-1", "政治", "active", "test")
        with self.assertRaises(ValueError, msg="伪造的任务 ID 不得写入学习事件"):
            self.s.record_student_event({"studentId": student_id, "courseKey": "course-1", "action": "plan_task_progress", "metadata": {"key": "2026-09-02:recite-ffffffff", "status": "done"}})
        now = self.s.utc_now()
        with self.s.open_database() as connection:
            connection.execute("INSERT INTO recite_items(id, student_id, course_key, prompt, answer, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'new', ?, ?)", ("recite-real-01", student_id, "course-1", "问题", "答案", now, now))
        self.s.record_student_event({"studentId": student_id, "courseKey": "course-1", "action": "plan_task_progress", "metadata": {"key": "2026-09-02:recite-real-01", "status": "done"}})

    def test_practice_submit_persists_feedback_points(self):
        student_id = "student-points-01"
        self._student(student_id, "13800000028")
        self.s.upsert_course_entitlement(student_id, "course-1", "政治", "active", "test")
        now = self.s.utc_now()
        with self.s.open_database() as connection:
            connection.execute("INSERT INTO practice_items(id, student_id, course_key, bank, stem, question_type, reference_answer, rubric_json, status, created_at, updated_at) VALUES (?, ?, ?, 'ai', '简述实践观', 'short_answer', '参考答案', '[]', 'active', ?, ?)", ("practice-pts-01", student_id, "course-1", now, now))
        graded = {"isCorrect": False, "score": 40, "result": "graded", "errorType": "knowledge_gap", "feedback": "漏答核心要点。", "rubric": [], "hitPoints": ["实践概念"], "missedPoints": ["实践与认识关系"], "wrongPoints": [], "redundantPoints": ["重复背景"], "loopAction": "none", "loopSummary": ""}
        with patch.object(self.s, "evaluate_practice_answer", return_value=graded):
            self.s.practice_submit({"studentId": student_id, "courseKey": "course-1", "subject": "政治", "itemId": "practice-pts-01", "answer": "我的作答"})
        with self.s.open_database() as connection:
            row = connection.execute("SELECT points_json FROM practice_attempts WHERE student_id=? AND practice_item_id=?", (student_id, "practice-pts-01")).fetchone()
        points = json.loads(row["points_json"])
        self.assertEqual(points["missedPoints"], ["实践与认识关系"])
        self.assertEqual(points["redundantPoints"], ["重复背景"])

    def test_self_test_review_enqueues_recall_cards(self):
        student_id = "student-recall-01"
        self._student(student_id, "13800000029")
        self.s.upsert_course_entitlement(student_id, "course-1", "政治", "active", "test")
        now = self.s.utc_now()
        with self.s.open_database() as connection:
            connection.execute("INSERT INTO student_course_self_tests(id, student_id, course_key, test_type, test_date, question_json, generated_at) VALUES (?, ?, ?, 'daily', ?, ?, ?)", ("selftest-recall-01", student_id, "course-1", "2026-09-02", json.dumps({"items": [{"id": "q1", "title": "实践观", "points": 10, "answer": "参考", "rubric": "要点"}]}, ensure_ascii=False), now))
        graded = {"score": 40, "total": 10, "summary": "需复习", "items": [{"id": "q1", "correct": False, "score": 4, "maxScore": 10, "feedback": "漏答要点", "reviewPriority": "high", "nextRecallCards": ["实践与认识的辩证关系"], "missingPoints": ["辩证关系"], "wrongPoints": []}]}
        with patch.object(self.s, "self_test_robot_settings", return_value={"enabled": True, "modelConfigured": True, "modelId": "", "prompt": "", "constraints": ""}), patch.object(self.s, "call_model", return_value=graded):
            result = self.s.review_self_test({"studentId": student_id, "courseKey": "course-1", "testId": "selftest-recall-01", "answers": {"q1": "我的答案"}})
        self.assertEqual(result["recallEnqueued"], 1, "答错并给出回忆卡的自测必须回流到带背队列")
        with self.s.open_database() as connection:
            card = connection.execute("SELECT answer, origin FROM recite_items WHERE student_id=? AND course_key=? AND origin='self_test'", (student_id, "course-1")).fetchone()
            loop = connection.execute("SELECT kind FROM loop_events WHERE student_id=? AND kind='self_test_to_recite'", (student_id,)).fetchone()
        self.assertEqual(card["answer"], "实践与认识的辩证关系")
        self.assertIsNotNone(loop)

    def test_recite_session_lifecycle_blocks_completion_while_paused(self):
        student_id = "student-session-01"
        self._student(student_id, "13800000030")
        self.s.upsert_course_entitlement(student_id, "course-1", "政治", "active", "test")
        started = self.s.recite_session_start({"studentId": student_id, "courseKey": "course-1", "subject": "政治"})
        session_id = started["session"]["sessionId"]
        self.assertEqual(started["session"]["status"], "active")
        again = self.s.recite_session_start({"studentId": student_id, "courseKey": "course-1", "subject": "政治"})
        self.assertEqual(again["session"]["sessionId"], session_id, "同一天重复开始必须复用同一会话")
        paused = self.s.recite_session_pause({"studentId": student_id, "courseKey": "course-1", "sessionId": session_id})
        self.assertEqual(paused["session"]["status"], "paused")
        with self.assertRaises(ValueError, msg="暂停中不得继续记录带背反馈"):
            self.s.recite_complete({"studentId": student_id, "courseKey": "course-1", "subject": "政治", "itemId": "recite-any", "result": "recited"})
        resumed = self.s.recite_session_resume({"studentId": student_id, "courseKey": "course-1", "sessionId": session_id})
        self.assertEqual(resumed["session"]["status"], "active")
        finished = self.s.recite_session_finish({"studentId": student_id, "courseKey": "course-1", "sessionId": session_id})
        self.assertEqual(finished["session"]["status"], "finished")
        history = self.s.recite_session_history({"studentId": student_id, "courseKey": "course-1", "subject": "政治"})
        self.assertEqual(history["sessions"][0]["sessionId"], session_id)

    def test_course_rejection_sends_student_notification_with_reason(self):
        student_id = "student-notice-02"
        self._student(student_id, "13800000031")
        self.s.request_base_course_access({"studentId": student_id, "displayName": student_id, "courseRegistration": {"school": "示例大学", "college": "商学院", "major": "政治学", "majorCode": "0302", "courseName": "政治学原理", "subjectCode": "701"}})
        self.s.update_base_course_access({"studentId": student_id, "baseCourseEnabled": False, "reason": "请补充招生学院全称。"})
        notices = self.s.student_notifications(student_id, course_key="course-1")["notifications"]
        self.assertEqual(len(notices), 1)
        self.assertEqual(notices[0]["kind"], "course_request")
        self.assertIn("请补充招生学院全称", notices[0]["message"])

    def test_admin_rerun_analysis_validates_student_and_entitlement(self):
        student_id = "student-rerun-01"
        self._student(student_id, "13800000032")
        with self.assertRaises(ValueError, msg="学生标识格式非法时必须拒绝"):
            self.s.admin_rerun_analysis({"studentId": "bad", "courseKey": "course-1"})
        with self.assertRaises(PermissionError, msg="未授权课程不得由教师触发重分析"):
            self.s.admin_rerun_analysis({"studentId": student_id, "courseKey": "course-9"})
        self.s.upsert_course_entitlement(student_id, "course-1", "政治", "active", "test")
        with self.assertRaises(RuntimeError, msg="未配置文本模型时重分析必须失败而不是伪造成功"):
            self.s.admin_rerun_analysis({"studentId": student_id, "courseKey": "course-1"})
        with self.s.open_database() as connection:
            run = connection.execute(
                "SELECT status, error FROM course_analysis_runs WHERE student_id=? AND course_key=? ORDER BY created_at DESC",
                (student_id, "course-1"),
            ).fetchone()
            audit = connection.execute(
                "SELECT action FROM audit_log WHERE actor_type='admin' AND action='analysis_rerun' AND target_id=?",
                (student_id,),
            ).fetchone()
        self.assertIsNotNone(run, "重分析必须先落一条 staging run 记录")
        self.assertEqual(run["status"], "failed", "模型缺失时 run 必须标记 failed，旧结果保持可用")
        self.assertIn("文本模型", run["error"])
        self.assertIsNone(audit, "失败的重分析不应写成已成功审计")

    def test_admin_rerun_analysis_rejects_deleted_and_disabled_student(self):
        student_id = "student-rerun-02"
        self._student(student_id, "13800000033")
        self.s.upsert_course_entitlement(student_id, "course-1", "政治", "active", "test")
        with self.s.open_database() as connection:
            connection.execute("UPDATE student_accounts SET status='disabled' WHERE student_id=?", (student_id,))
        with self.assertRaises(self.s.AccountDisabledError, msg="停用账号不得触发重分析"):
            self.s.admin_rerun_analysis({"studentId": student_id, "courseKey": "course-1"})
        with self.s.open_database() as connection:
            connection.execute("UPDATE student_accounts SET status='active' WHERE student_id=?", (student_id,))
            connection.execute("INSERT INTO deleted_students(student_id, deleted_at) VALUES (?, ?)", (student_id, self.s.now_iso()))
        with self.assertRaises(self.s.StudentDeletedError, msg="已删除档案不得触发重分析"):
            self.s.admin_rerun_analysis({"studentId": student_id, "courseKey": "course-1"})


    def test_admin_student_detail_scopes_data_to_requested_student(self):
        student_id = "student-detail-01"
        other_id = "student-detail-02"
        self._student(student_id, "13800000041")
        self._student(other_id, "13800000042")
        self.s.upsert_course_entitlement(student_id, "course-1", "政治", "active", "test")
        self.s.upsert_course_entitlement(student_id, "course-2", "历史", "active", "test")
        self.s.upsert_course_entitlement(other_id, "course-9", "英语", "active", "test")
        self._write_index([
            {"id": "doc-detail-1", "name": "本人.txt", "kind": "text", "studentId": student_id, "courseKey": "course-1", "courseName": "政治", "status": "parsed", "updatedAt": "2026-09-01T00:00:00+00:00"},
            {"id": "doc-detail-2", "name": "他人.txt", "kind": "text", "studentId": other_id, "courseKey": "course-9", "courseName": "英语", "status": "parsed", "updatedAt": "2026-09-02T00:00:00+00:00"},
        ])
        now = self.s.utc_now()
        with self.s.open_database() as connection:
            connection.execute(
                "INSERT INTO course_analysis_runs(id, student_id, course_key, course_name, status, stats_json, error, created_at, completed_at) VALUES (?, ?, ?, ?, 'completed', ?, '', ?, ?)",
                ("run-detail-1", student_id, "course-1", "政治", json.dumps({"knowledge": 2, "recite": 3, "practice": 4}), now, now),
            )
            connection.execute(
                "INSERT INTO course_analysis_runs(id, student_id, course_key, course_name, status, stats_json, error, created_at, completed_at) VALUES (?, ?, ?, ?, 'failed', '{}', '他人失败原因', ?, ?)",
                ("run-detail-2", other_id, "course-9", "英语", now, now),
            )
            connection.execute(
                "INSERT INTO knowledge_entries(id, student_id, course_key, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                ("know-detail-1", student_id, "course-1", "知识点", now, now),
            )
            connection.execute(
                "INSERT INTO recite_items(id, student_id, course_key, prompt, answer, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'new', ?, ?)",
                ("recite-detail-1", student_id, "course-1", "问题", "答案", now, now),
            )
            connection.execute(
                "INSERT INTO practice_items(id, student_id, course_key, bank, stem, question_type, reference_answer, rubric_json, status, created_at, updated_at) VALUES (?, ?, ?, 'ai', '题干', 'short_answer', '答案', '[]', 'active', ?, ?)",
                ("practice-detail-1", student_id, "course-1", now, now),
            )
            connection.execute(
                "INSERT INTO recite_items(id, student_id, course_key, prompt, answer, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'new', ?, ?)",
                ("recite-detail-2", other_id, "course-9", "他人问题", "他人答案", now, now),
            )
        detail = self.s.admin_student_detail(student_id)
        self.assertEqual(detail["profile"]["studentId"], student_id)
        self.assertEqual([item["courseKey"] for item in detail["entitlements"]], ["course-1", "course-2"])
        self.assertEqual(detail["entitlements"][0]["courseName"], "政治")
        self.assertEqual(detail["entitlements"][0]["status"], "active")
        self.assertEqual([doc["id"] for doc in detail["documents"]], ["doc-detail-1"])
        self.assertEqual(detail["counts"]["course-1"], {"knowledge": 1, "recite": 1, "practice": 1})
        self.assertEqual(detail["counts"]["course-2"], {"knowledge": 0, "recite": 0, "practice": 0}, "已授权但无内容的课程必须显式返回零计数")
        self.assertNotIn("course-9", detail["counts"], "其他学生的课程计数不得混入")
        content = detail.get("content") or {}
        self.assertIn("course-1", content, "教师端必须能看到课程学习产出")
        self.assertEqual([item["title"] for item in content["course-1"]["knowledge"]], ["知识点"])
        self.assertEqual([item["prompt"] for item in content["course-1"]["recite"]], ["问题"])
        self.assertEqual([item["stem"] for item in content["course-1"]["practice"]], ["题干"])
        self.assertNotIn("course-9", content, "其他学生的产出不得混入")
        runs = detail["analysisRuns"]["course-1"]
        self.assertEqual([run["id"] for run in runs], ["run-detail-1"])
        self.assertEqual(runs[0]["status"], "completed")
        self.assertEqual(runs[0]["stats"]["knowledge"], 2)
        self.assertNotIn("course-9", detail["analysisRuns"], "其他学生的分析记录不得混入")

    def test_admin_student_detail_rejects_unknown_student(self):
        self.s.ensure_data_dirs()
        with self.assertRaises(ValueError, msg="不存在的学生必须抛 ValueError 而不是返回空档案"):
            self.s.admin_student_detail("student-none-01")

    # ---------- 生产模式 HTTP 回归（A05/AC-04/AC-06/AC-16/AC-18） ----------

    def _env(self, key, value):
        old = os.environ.get(key)
        self.addCleanup(lambda: os.environ.pop(key, None) if old is None else os.environ.__setitem__(key, old))
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value

    def _start_http(self):
        """在本机回环临时端口启动真实 API，数据仍落在本测试的临时目录。"""
        self.s.ensure_data_dirs()
        httpd = self.s.YanbanHTTPServer(("127.0.0.1", 0), self.s.ApiHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        # shutdown 必须先于 server_close，否则 Windows 上 serve_forever 会对已关闭的套接字 select。
        self.addCleanup(lambda: (httpd.shutdown(), httpd.server_close()))
        return f"http://127.0.0.1:{httpd.server_address[1]}"

    def _http(self, base, method, path, payload=None, token=None, headers=None):
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = urllib.request.Request(base + path, data=body, method=method)
        request.add_header("Content-Type", "application/json")
        if token:
            request.add_header("Authorization", f"Bearer {token}")
        for key, value in (headers or {}).items():
            request.add_header(key, value)
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, json.loads(response.read().decode("utf-8") or "{}"), dict(response.headers)
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read().decode("utf-8") or "{}"), dict(error.headers)

    def test_production_http_requires_session_and_rejects_foreign_student(self):
        self._env("YANBAN_LOCAL_TEST_MODE", "0")
        self._env("YANBAN_ADMIN_TOKEN", "test-admin-token-0123456789")
        alice, bob = "student-http-a1", "student-http-b2"
        self._student(alice, "13800000040")
        self._student(bob, "13800000041")
        self.s.upsert_course_entitlement(alice, "course-1", "政治", "active", "test")
        token_a = self.s.student_login({"phone": "13800000040", "password": "correct horse battery"})["sessionToken"]
        base = self._start_http()

        status, body, _ = self._http(base, "POST", "/api/students/workspace", {"studentId": alice, "courseKey": "course-1", "workspace": {"subject": "政治"}})
        self.assertEqual(status, 403, "生产模式下无 session 的业务请求必须被拒绝")
        self.assertEqual(body.get("error"), "forbidden")

        status, body, _ = self._http(base, "POST", "/api/students/workspace", {"studentId": bob, "courseKey": "course-1", "workspace": {"subject": "政治"}}, token=token_a)
        self.assertEqual(status, 403, "session 属于 A 时不得用 B 的 studentId 写数据")

        status, body, _ = self._http(base, "POST", "/api/students/workspace", {"courseKey": "course-1", "workspace": {"subject": "政治"}}, token=token_a)
        self.assertEqual(status, 200, "session 有效且课程已授权时请求必须成功（身份取自服务端 session）")

        status, body, _ = self._http(base, "GET", "/api/admin/students")
        self.assertEqual(status, 401)
        self.assertEqual(body.get("error"), "admin_unauthorized")

        status, body, _ = self._http(base, "GET", "/api/admin/students", token=token_a)
        self.assertEqual(status, 401, "学生 token 不得访问管理接口")

        status, body, _ = self._http(base, "GET", "/api/admin/students", token="test-admin-token-0123456789")
        self.assertEqual(status, 200, "正确管理员 token 应通过校验")

    def test_production_http_disabled_account_returns_stable_error(self):
        self._env("YANBAN_LOCAL_TEST_MODE", "0")
        student_id = "student-http-c3"
        self._student(student_id, "13800000042")
        self.s.upsert_course_entitlement(student_id, "course-1", "政治", "active", "test")
        token = self.s.student_login({"phone": "13800000042", "password": "correct horse battery"})["sessionToken"]
        base = self._start_http()
        with self.s.open_database() as connection:
            connection.execute("UPDATE student_accounts SET status='disabled' WHERE student_id=?", (student_id,))
        status, body, _ = self._http(base, "POST", "/api/students/workspace", {"courseKey": "course-1", "workspace": {"subject": "政治"}}, token=token)
        self.assertEqual(status, 403)
        self.assertEqual(body.get("error"), "account_disabled", "停用账号后已签发 token 必须立即失效并返回稳定错误码")

    def test_local_test_shortcut_only_applies_to_loopback(self):
        self._env("YANBAN_LOCAL_TEST_MODE", "1")
        self._env("YANBAN_ADMIN_TOKEN", None)
        loopback = types.SimpleNamespace(client_address=("127.0.0.1", 9000), headers={})
        loopback.is_local_testing = lambda: self.s.ApiHandler.is_local_testing(loopback)
        self.assertTrue(self.s.ApiHandler.is_local_testing(loopback))
        self.assertTrue(self.s.ApiHandler.is_admin(loopback), "回环地址才允许本地测试捷径")

        remote = types.SimpleNamespace(client_address=("10.10.0.8", 9000), headers={})
        remote.is_local_testing = lambda: self.s.ApiHandler.is_local_testing(remote)
        self.assertFalse(self.s.ApiHandler.is_local_testing(remote), "非回环地址不得进入本地测试捷径")
        self.assertFalse(self.s.ApiHandler.is_admin(remote), "非回环地址即使打开本地测试开关也必须校验管理员令牌")

    def test_cors_production_allows_only_explicit_https_whitelist(self):
        self._env("YANBAN_LOCAL_TEST_MODE", "0")
        self._env("YANBAN_CORS_ORIGINS", None)
        base = self._start_http()
        status, body, _ = self._http(base, "OPTIONS", "/api/health", headers={"Origin": "https://evil.example.com"})
        self.assertEqual(status, 403, "未配置白名单时生产跨域必须拒绝")
        self.assertEqual(body.get("error"), "cors_not_allowed")

        os.environ["YANBAN_CORS_ORIGINS"] = "https://app.example.com,http://insecure.example.com"
        status, _, headers = self._http(base, "OPTIONS", "/api/health", headers={"Origin": "https://app.example.com"})
        self.assertEqual(status, 204)
        self.assertEqual(headers.get("Access-Control-Allow-Origin"), "https://app.example.com")
        status, _, _ = self._http(base, "OPTIONS", "/api/health", headers={"Origin": "http://insecure.example.com"})
        self.assertEqual(status, 403, "白名单中的 http 源在生产环境同样必须拒绝")

    def test_payment_submission_does_not_unlock_course(self):
        student_id = "student-pay-01"
        self._student(student_id, "13800000043")
        result = self.s.request_base_course_access({
            "studentId": student_id,
            "displayName": student_id,
            "paymentReference": "PAY-2026-0001",
            "paymentNote": "已转账，请查收",
            "courseRegistration": {"school": "示例大学", "college": "商学院", "major": "政治学", "majorCode": "0302", "courseName": "政治学原理", "subjectCode": "701"},
        })
        access = result["courseAccess"]
        self.assertFalse(access["baseCourseEnabled"], "提交付款凭证不得自动开通课程")
        self.assertEqual(access["requestStatus"], "pending", "课程授权必须停留在教师审核，不得因付款提交变为已通过")
        with self.s.open_database() as connection:
            entitlement = connection.execute("SELECT 1 FROM student_course_entitlements WHERE student_id=?", (student_id,)).fetchone()
            payment = connection.execute("SELECT payment_reference FROM student_payment_submissions WHERE student_id=?", (student_id,)).fetchone()
        self.assertIsNone(entitlement, "未配置真实支付服务时不得生成课程 entitlement")
        self.assertEqual(payment["payment_reference"], "PAY-2026-0001", "付款凭证只能作为待审核记录保存")

    def test_initialize_database_migrates_legacy_schema_without_data_loss(self):
        # 手工构造旧版库：paper_material_packages 缺少后加的三列，且没有状态历史表。
        self.s.DATA_DIR.mkdir(parents=True, exist_ok=True)
        legacy = sqlite3.connect(self.s.DATABASE_PATH)
        legacy.executescript("""
            CREATE TABLE students (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL);
            CREATE TABLE paper_material_packages (
                id TEXT PRIMARY KEY, student_id TEXT NOT NULL, course_key TEXT NOT NULL,
                course_name TEXT NOT NULL DEFAULT '', analysis_run_id TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'ready', material_types_json TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
        """)
        legacy.execute("INSERT INTO students(id, display_name, created_at, last_seen_at) VALUES ('student-legacy-01', '旧库学生', '2026-08-01T00:00:00', '2026-08-01T00:00:00')")
        legacy.execute("INSERT INTO paper_material_packages(id, student_id, course_key, course_name, status, created_at, updated_at) VALUES ('paper-legacy-01', 'student-legacy-01', 'course-1', '政治', 'ready', '2026-08-01T00:00:00', '2026-08-01T00:00:00')")
        legacy.commit()
        legacy.close()

        self.s.initialize_database()

        with self.s.open_database() as connection:
            columns = {row["name"] for row in connection.execute("PRAGMA table_info(paper_material_packages)")}
            row = connection.execute("SELECT id, status FROM paper_material_packages WHERE id='paper-legacy-01'").fetchone()
            tables = {item["name"] for item in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertTrue({"printed_at", "shipped_at", "additional_sections_json"} <= columns, "旧库必须自动补齐后加列")
        self.assertIn("paper_package_status_history", tables, "旧库必须自动补建状态历史表")
        self.assertEqual(row["status"], "ready", "迁移不得破坏既有行数据")

    # ---------- 师兄反馈批次：收货信息 / 收信箱 / 快递 ----------

    def test_student_profile_shipping_fields_roundtrip(self):
        student_id = "student-shipping-01"
        self._student(student_id, "13800000050")
        self.s.update_student_profile({
            "studentId": student_id, "displayName": student_id,
            "shippingRecipient": "卷卷", "shippingPhone": "13900000000",
            "shippingInfo": "北京市海淀区中关村大街 1 号",
        })
        profile = self.s.student_profile(student_id)
        self.assertEqual(profile["shippingRecipient"], "卷卷")
        self.assertEqual(profile["shippingPhone"], "13900000000")
        self.assertEqual(profile["shippingInfo"], "北京市海淀区中关村大街 1 号")
        detail = self.s.admin_student_detail(student_id)
        self.assertEqual(detail["profile"]["shippingInfo"], "北京市海淀区中关村大街 1 号", "教师端学习详情必须拿到收货字段")
        listed = {row["id"]: row for row in self.s.admin_students()}
        self.assertEqual(listed[student_id]["shippingRecipient"], "卷卷", "教师端学生列表必须返回收货字段")
        result = self.s.update_student_self_profile({"studentId": student_id, "displayName": student_id, "shippingInfo": "上海市徐汇区漕溪北路 2 号"})
        self.assertTrue(result["ok"])
        updated = self.s.student_profile(student_id)
        self.assertEqual(updated["shippingInfo"], "上海市徐汇区漕溪北路 2 号", "学生自助保存必须写入收货地址")
        self.assertEqual(updated["shippingRecipient"], "卷卷", "未提交的收货字段必须保留教师端已填值")
        self.s.update_student_profile({"studentId": student_id, "displayName": student_id, "phone": "13700000000"})
        preserved = self.s.student_profile(student_id)
        self.assertEqual(preserved["shippingInfo"], "上海市徐汇区漕溪北路 2 号", "教师编辑其他字段时不得清空未提交的收货字段")
        self.assertEqual(preserved["shippingPhone"], "13900000000")

    def test_admin_message_reaches_only_target_student_inbox(self):
        alice, bob = "student-inbox-a1", "student-inbox-b2"
        self._student(alice, "13800000051")
        self._student(bob, "13800000052")
        self.s.upsert_course_entitlement(alice, "course-1", "政治", "active", "test")
        self.s.upsert_course_entitlement(bob, "course-1", "政治", "active", "test")
        result = self.s.admin_send_message({"studentId": alice, "title": "资料已寄出", "message": "单号稍后补充，注意查收。"})
        self.assertTrue(result["ok"])
        notification = result["notification"]
        self.assertEqual(notification["kind"], "teacher_message")
        inbox = self.s.student_notifications(alice, course_key="course-1")["notifications"]
        self.assertEqual([item["id"] for item in inbox], [notification["id"]])
        self.assertEqual(inbox[0]["title"], "资料已寄出")
        self.assertEqual(inbox[0]["message"], "单号稍后补充，注意查收。")
        self.assertFalse(inbox[0]["readAt"])
        self.assertEqual(self.s.student_notifications(bob, course_key="course-1")["notifications"], [], "教师消息不得出现在其他学生的收信箱")
        read = self.s.mark_student_notification_read(alice, notification["id"], "course-1")
        self.assertTrue(read["ok"])
        self.assertTrue(self.s.student_notifications(alice, course_key="course-1")["notifications"][0]["readAt"], "标记已读必须生效")
        recent = self.s.admin_student_messages(alice)
        self.assertEqual([item["id"] for item in recent["messages"]], [notification["id"]])
        with self.assertRaises(ValueError):
            self.s.admin_send_message({"studentId": alice, "title": "", "message": "缺少标题"})
        with self.assertRaises(ValueError):
            self.s.admin_send_message({"studentId": alice, "title": "标题", "message": ""})
        with self.assertRaises(ValueError):
            self.s.admin_send_message({"studentId": "student-absent-01", "title": "标题", "message": "正文"})
        with self.s.open_database() as connection:
            audit = connection.execute("SELECT 1 FROM audit_log WHERE action='teacher_message_sent' AND target_id=?", (alice,)).fetchone()
        self.assertIsNotNone(audit, "教师发消息必须写审计事件")

    def test_paper_package_tracking_and_delivery_flow(self):
        student_id = "student-package-01"
        self._student(student_id, "13800000053")
        self.s.upsert_course_entitlement(student_id, "course-1", "政治", "active", "test")
        package_id = self.s.upsert_paper_material_package(student_id, "course-1", "政治")
        with self.assertRaises(ValueError, msg="未寄出的资料包不得标记送达"):
            self.s.mark_paper_package_delivered({"packageId": package_id})
        saved = self.s.save_paper_package_tracking({"packageId": package_id, "trackingNumber": "SF123456789", "carrier": "顺丰速运", "etaDays": 3})
        self.assertTrue(saved["ok"])
        packages = self.s.student_packages(student_id, "course-1")["packages"]
        self.assertEqual(len(packages), 1)
        self.assertEqual(packages[0]["trackingNumber"], "SF123456789")
        self.assertEqual(packages[0]["carrier"], "顺丰速运")
        self.assertEqual(packages[0]["etaDays"], 3)
        self.assertEqual(packages[0]["statusLabel"], "内容不完整")
        self.assertEqual(packages[0]["deliveredAt"], "")
        with self.assertRaises(PermissionError, msg="未授权课程不得读取快递信息"):
            self.s.student_packages(student_id, "course-9")
        self.s.update_paper_material_status(package_id, "ready")
        self.s.update_paper_material_status(package_id, "printing")
        self.s.update_paper_material_status(package_id, "printed")
        self.s.update_paper_material_status(package_id, "shipped")
        delivered = self.s.mark_paper_package_delivered({"packageId": package_id})
        self.assertTrue(delivered["ok"])
        self.assertEqual(delivered["status"], "shipped", "标记送达不得破坏既有状态机")
        self.assertTrue(delivered["deliveredAt"])
        after = self.s.student_packages(student_id, "course-1")["packages"][0]
        self.assertEqual(after["deliveredAt"], delivered["deliveredAt"])
        self.assertEqual(after["statusLabel"], "已寄出")
        delivered_notices = [item for item in self.s.student_notifications(student_id, course_key="course-1")["notifications"] if item["kind"] == "package_delivered"]
        self.assertEqual(len(delivered_notices), 1, "送达后学生必须收到一条 package_delivered 通知")
        self.assertIn("政治", delivered_notices[0]["message"], "送达通知必须包含资料包课程名")
        again = self.s.mark_paper_package_delivered({"packageId": package_id})
        self.assertTrue(again.get("alreadyDelivered"), "重复标记必须幂等")
        notices_again = [item for item in self.s.student_notifications(student_id, course_key="course-1")["notifications"] if item["kind"] == "package_delivered"]
        self.assertEqual(len(notices_again), 1, "重复标记不得重复通知学生")
        with self.s.open_database() as connection:
            history = connection.execute("SELECT COUNT(1) AS c FROM paper_package_status_history WHERE package_id=? AND note LIKE '%快递单号%'", (package_id,)).fetchone()
            audit = connection.execute("SELECT 1 FROM audit_log WHERE action='paper_package_delivered' AND target_id=?", (package_id,)).fetchone()
        self.assertGreaterEqual(history["c"], 1, "填写单号必须写状态历史")
        self.assertIsNotNone(audit, "标记送达必须写审计事件")

    def test_admin_message_and_tracking_endpoints_require_admin(self):
        self._env("YANBAN_LOCAL_TEST_MODE", "0")
        self._env("YANBAN_ADMIN_TOKEN", "test-admin-token-0123456789")
        student_id = "student-http-d4"
        self._student(student_id, "13800000054")
        self.s.upsert_course_entitlement(student_id, "course-1", "政治", "active", "test")
        token = self.s.student_login({"phone": "13800000054", "password": "correct horse battery"})["sessionToken"]
        base = self._start_http()
        for method, path, payload in (
            ("POST", "/api/admin/messages", {"studentId": student_id, "title": "t", "message": "m"}),
            ("POST", "/api/admin/paper-materials/tracking", {"packageId": "paper-x", "trackingNumber": "n"}),
            ("POST", "/api/admin/paper-materials/mark-delivered", {"packageId": "paper-x"}),
        ):
            status, body, _ = self._http(base, method, path, payload)
            self.assertEqual(status, 401, f"{path} 无管理员 token 必须拒绝")
            self.assertEqual(body.get("error"), "admin_unauthorized")
            status, _, _ = self._http(base, method, path, payload, token=token)
            self.assertEqual(status, 401, f"{path} 学生 token 不得访问")
        status, _, _ = self._http(base, "GET", f"/api/admin/messages?studentId={student_id}")
        self.assertEqual(status, 401, "GET /api/admin/messages 无管理员 token 必须拒绝")
        status, body, _ = self._http(base, "POST", "/api/admin/messages", {"studentId": student_id, "title": "欢迎", "message": "收到请回复"}, token="test-admin-token-0123456789")
        self.assertEqual(status, 200, "正确管理员 token 应能发消息")
        self.assertEqual(body["notification"]["kind"], "teacher_message")
        status, body, _ = self._http(base, "GET", "/api/students/packages?studentId=" + student_id + "&courseKey=course-1", token=token)
        self.assertEqual(status, 200)
        self.assertIn("packages", body)
        status, body, _ = self._http(base, "GET", "/api/students/packages?studentId=student-http-other&courseKey=course-1", token=token)
        self.assertEqual(status, 403, "学生 session 不得读取他人快递信息")

    # ---------- 教师端管理员账号体系（master 分发 teacher 账号） ----------

    def _bootstrap_master(self, base, token="test-admin-token-0123456789", username="shixiong", password="master-pass-123"):
        status, body, _ = self._http(base, "POST", "/api/admin/accounts/bootstrap", {"username": username, "password": password}, token=token)
        self.assertEqual(status, 201, f"主账号 bootstrap 应成功：{body}")
        self.assertEqual(body.get("role"), "master")
        return body

    def _login_admin(self, base, username, password):
        return self._http(base, "POST", "/api/admin/accounts/login", {"username": username, "password": password})

    def test_admin_bootstrap_login_and_session_grants_admin_access(self):
        self._env("YANBAN_LOCAL_TEST_MODE", "0")
        self._env("YANBAN_ADMIN_TOKEN", "test-admin-token-0123456789")
        base = self._start_http()
        self._bootstrap_master(base)

        status, body, _ = self._login_admin(base, "shixiong", "wrong-password-1")
        self.assertEqual(status, 422)
        self.assertIn("账号或密码不正确", body.get("message", ""), "密码错误与账号不存在必须统一文案")
        status, body, _ = self._login_admin(base, "nobody-here", "wrong-password-1")
        self.assertEqual(status, 422)
        self.assertIn("账号或密码不正确", body.get("message", ""))

        status, body, _ = self._login_admin(base, "shixiong", "master-pass-123")
        self.assertEqual(status, 200)
        self.assertEqual(body.get("role"), "master")
        self.assertEqual(body.get("username"), "shixiong")
        session = body["sessionToken"]

        status, _, _ = self._http(base, "GET", "/api/admin/students", token=session)
        self.assertEqual(status, 200, "账号会话令牌应与旧管理员令牌一样通过 is_admin")

        with self.s.open_database() as connection:
            row = connection.execute("SELECT last_login_at FROM admin_accounts WHERE username='shixiong'").fetchone()
        self.assertTrue(row["last_login_at"], "登录必须更新 last_login_at")

        status, _, _ = self._http(base, "POST", "/api/admin/accounts/logout", {}, token=session)
        self.assertEqual(status, 200)
        status, _, _ = self._http(base, "GET", "/api/admin/students", token=session)
        self.assertEqual(status, 401, "登出后会话必须立即失效")

    def test_admin_master_creates_teacher_and_teacher_cannot_manage_accounts(self):
        self._env("YANBAN_LOCAL_TEST_MODE", "0")
        self._env("YANBAN_ADMIN_TOKEN", "test-admin-token-0123456789")
        base = self._start_http()
        self._bootstrap_master(base)
        _, master_login, _ = self._login_admin(base, "shixiong", "master-pass-123")
        master = master_login["sessionToken"]

        status, _, _ = self._http(base, "POST", "/api/admin/accounts", {"username": "ab", "password": "teacher-pass-1", "role": "teacher"}, token=master)
        self.assertEqual(status, 422, "用户名不足 3 位必须拒绝")
        status, _, _ = self._http(base, "POST", "/api/admin/accounts", {"username": "teacher1", "password": "short", "role": "teacher"}, token=master)
        self.assertEqual(status, 422, "密码不足 8 位必须拒绝")

        status, body, _ = self._http(base, "POST", "/api/admin/accounts", {"username": "teacher1", "password": "teacher-pass-1", "role": "teacher"}, token=master)
        self.assertEqual(status, 201)
        teacher_id = body["accountId"]
        status, _, _ = self._http(base, "POST", "/api/admin/accounts", {"username": "teacher1", "password": "teacher-pass-2", "role": "teacher"}, token=master)
        self.assertEqual(status, 422, "重复用户名必须 422")
        status, _, _ = self._http(base, "POST", "/api/admin/accounts", {"username": "secondmaster", "password": "master-pass-456", "role": "master"}, token=master)
        self.assertEqual(status, 422, "master 唯一，不能创建第二个主账号")

        status, body, _ = self._http(base, "GET", "/api/admin/accounts", token=master)
        self.assertEqual(status, 200)
        accounts = body["accounts"]
        self.assertEqual({account["username"] for account in accounts}, {"shixiong", "teacher1"})
        for account in accounts:
            serialized = json.dumps(account).lower()
            self.assertNotIn("password", serialized, "账号列表绝不得包含口令字段")
            self.assertNotIn("hash", serialized, "账号列表绝不得包含散列字段")

        status, body, _ = self._login_admin(base, "teacher1", "teacher-pass-1")
        self.assertEqual(status, 200)
        self.assertEqual(body.get("role"), "teacher")
        teacher = body["sessionToken"]

        status, _, _ = self._http(base, "GET", "/api/admin/students", token=teacher)
        self.assertEqual(status, 200, "教师账号会话同样是 admin")
        for method, path, payload in (
            ("GET", "/api/admin/accounts", None),
            ("POST", "/api/admin/accounts", {"username": "teacher2", "password": "teacher-pass-2", "role": "teacher"}),
            ("POST", "/api/admin/accounts/status", {"accountId": teacher_id, "status": "disabled"}),
            ("POST", "/api/admin/accounts/reset-password", {"accountId": teacher_id, "password": "teacher-pass-9"}),
        ):
            status, body, _ = self._http(base, method, path, payload, token=teacher)
            self.assertEqual(status, 403, f"teacher 调 {path} 必须 403")
            self.assertEqual(body.get("error"), "master_required")

        with self.s.open_database() as connection:
            audit = connection.execute("SELECT 1 FROM audit_log WHERE action='admin_account_created' AND target_id=?", (teacher_id,)).fetchone()
        self.assertIsNotNone(audit, "创建教师账号必须写审计事件")

    def test_admin_disable_teacher_revokes_sessions_immediately(self):
        self._env("YANBAN_LOCAL_TEST_MODE", "0")
        self._env("YANBAN_ADMIN_TOKEN", "test-admin-token-0123456789")
        base = self._start_http()
        master_id = self._bootstrap_master(base)["accountId"]
        _, master_login, _ = self._login_admin(base, "shixiong", "master-pass-123")
        master = master_login["sessionToken"]
        _, created, _ = self._http(base, "POST", "/api/admin/accounts", {"username": "teacher1", "password": "teacher-pass-1", "role": "teacher"}, token=master)
        teacher_id = created["accountId"]
        _, teacher_login, _ = self._login_admin(base, "teacher1", "teacher-pass-1")
        teacher = teacher_login["sessionToken"]
        status, _, _ = self._http(base, "GET", "/api/admin/students", token=teacher)
        self.assertEqual(status, 200)

        status, _, _ = self._http(base, "POST", "/api/admin/accounts/status", {"accountId": master_id, "status": "disabled"}, token=master)
        self.assertEqual(status, 422, "主账号不得停用自己")

        status, body, _ = self._http(base, "POST", "/api/admin/accounts/status", {"accountId": teacher_id, "status": "disabled"}, token=master)
        self.assertEqual(status, 200)
        self.assertEqual(body.get("status"), "disabled")
        status, _, _ = self._http(base, "GET", "/api/admin/students", token=teacher)
        self.assertEqual(status, 401, "停用账号后其会话必须立即失效")
        status, _, _ = self._login_admin(base, "teacher1", "teacher-pass-1")
        self.assertEqual(status, 422, "已停用账号不能再登录")

        status, _, _ = self._http(base, "POST", "/api/admin/accounts/status", {"accountId": teacher_id, "status": "active"}, token=master)
        self.assertEqual(status, 200)
        _, teacher_login2, _ = self._login_admin(base, "teacher1", "teacher-pass-1")
        teacher2 = teacher_login2["sessionToken"]
        status, _, _ = self._http(base, "POST", "/api/admin/accounts/reset-password", {"accountId": teacher_id, "password": "teacher-pass-9"}, token=master)
        self.assertEqual(status, 200)
        status, _, _ = self._http(base, "GET", "/api/admin/students", token=teacher2)
        self.assertEqual(status, 401, "重置密码后旧会话必须失效")
        status, body, _ = self._login_admin(base, "teacher1", "teacher-pass-9")
        self.assertEqual(status, 200, "重置后可用新密码登录")

    def test_admin_legacy_token_remains_valid_during_compat_window(self):
        self._env("YANBAN_LOCAL_TEST_MODE", "0")
        self._env("YANBAN_ADMIN_TOKEN", "test-admin-token-0123456789")
        base = self._start_http()
        status, _, _ = self._http(base, "POST", "/api/admin/auth/token", {}, token="test-admin-token-0123456789")
        self.assertEqual(status, 200, "旧管理员令牌必须保持可用")
        status, _, _ = self._http(base, "GET", "/api/admin/students", token="test-admin-token-0123456789")
        self.assertEqual(status, 200, "旧管理员令牌必须继续通过 is_admin")
        self._bootstrap_master(base)
        status, _, _ = self._http(base, "GET", "/api/admin/students", token="test-admin-token-0123456789")
        self.assertEqual(status, 200, "账号体系建立后旧令牌同样有效")
        status, _, _ = self._http(base, "GET", "/api/admin/accounts", token="test-admin-token-0123456789")
        self.assertEqual(status, 200, "兼容期内旧令牌按 master 处理")

    def test_admin_account_endpoints_closed_until_bootstrap(self):
        self._env("YANBAN_LOCAL_TEST_MODE", "0")
        self._env("YANBAN_ADMIN_TOKEN", "test-admin-token-0123456789")
        base = self._start_http()
        token = "test-admin-token-0123456789"
        for method, path, payload in (
            ("GET", "/api/admin/accounts", None),
            ("POST", "/api/admin/accounts", {"username": "teacher1", "password": "teacher-pass-1", "role": "teacher"}),
            ("POST", "/api/admin/accounts/status", {"accountId": "admin-x", "status": "disabled"}),
            ("POST", "/api/admin/accounts/reset-password", {"accountId": "admin-x", "password": "teacher-pass-9"}),
        ):
            status, body, _ = self._http(base, method, path, payload, token=token)
            self.assertEqual(status, 403, f"初始化前 {path} 不得开放")
            self.assertEqual(body.get("error"), "bootstrap_required")
        status, _, _ = self._login_admin(base, "shixiong", "master-pass-123")
        self.assertEqual(status, 422, "无账号时登录必然失败")
        status, body, _ = self._http(base, "POST", "/api/admin/accounts/bootstrap", {"username": "shixiong", "password": "master-pass-123"})
        self.assertEqual(status, 403, "bootstrap 仅允许旧管理员令牌调用")
        self.assertEqual(body.get("error"), "forbidden")
        self._bootstrap_master(base)
        status, _, _ = self._http(base, "POST", "/api/admin/accounts/bootstrap", {"username": "another", "password": "master-pass-123"}, token=token)
        self.assertEqual(status, 422, "已完成初始化后不得重复 bootstrap")
        status, _, _ = self._http(base, "GET", "/api/admin/accounts", token=token)
        self.assertEqual(status, 200, "初始化完成后 master 视角正常开放")

    def test_searxng_search_maps_results_and_takes_precedence(self):
        class StubSearXNG(BaseHTTPRequestHandler):
            def do_GET(self):
                body = json.dumps({"results": [{"title": "示例标题", "url": "https://example.com/a", "content": "示例内容"}]}).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                return

        self.s.ensure_data_dirs()
        stub = self.s.YanbanHTTPServer(("127.0.0.1", 0), StubSearXNG)
        threading.Thread(target=stub.serve_forever, daemon=True).start()
        self.addCleanup(lambda: (stub.shutdown(), stub.server_close()))
        base = f"http://127.0.0.1:{stub.server_address[1]}"
        with self.s.open_database() as connection:
            connection.execute(
                "INSERT INTO platform_settings(key, value, updated_at) VALUES('searxng_base_url', ?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (base, self.s.utc_now()),
            )
        rows = self.s.web_search_evidence("华中师范大学社会工作", "unit-test")
        self.assertEqual(len(rows), 1, "配置自建 SearXNG 后检索必须返回映射结果")
        self.assertEqual(rows[0]["url"], "https://example.com/a")
        self.assertEqual(rows[0]["evidenceId"], "unit-test-1")
        self.assertEqual(rows[0]["title"], "示例标题")
        check = self.s.test_tavily_connection()
        self.assertEqual(check["provider"], "searxng", "连通验证在配置 SearXNG 后必须报 searxng 而不是 Tavily")
        settings = self.s.admin_settings()
        self.assertEqual(settings["webSearch"]["provider"], "searxng")
        self.assertTrue(settings["webSearchConfigured"])
        with self.s.open_database() as connection:
            connection.execute("DELETE FROM platform_settings WHERE key='searxng_base_url'")
        self.assertEqual(self.s.web_search_evidence("华中师范大学社会工作", "unit-test"), [], "清空配置且无 Tavily Key 时必须诚实返回空，不得伪造结果")

    def test_searxng_base_url_settings_roundtrip_and_validation(self):
        self.s.ensure_data_dirs()
        updated = self.s.update_admin_settings({"searxngBaseUrl": "http://127.0.0.1:8080/"})
        self.assertEqual(updated["webSearch"]["searxngBaseUrl"], "http://127.0.0.1:8080", "保存时去除末尾斜杠并能在设置中读回")
        with self.assertRaises(ValueError, msg="非 http(s) 地址必须拒绝"):
            self.s.update_admin_settings({"searxngBaseUrl": "ftp://bad"})
        updated = self.s.update_admin_settings({"searxngBaseUrl": ""})
        self.assertEqual(updated["webSearch"]["searxngBaseUrl"], "", "留空必须允许回退 Tavily")

    def test_analysis_normalization_tolerates_chinese_priority_levels(self):
        raw = {
            "knowledgeEntries": [{"title": "实践观", "examPriority": "高", "sourceDocumentIds": ["doc-1"], "sourceChunkIds": ["c-1"], "evidenceStatus": "confirmed"}],
            "reciteItems": [{"prompt": "问题", "answer": "答案", "examPriority": "中", "difficulty": "高", "estimateSeconds": "约45秒"}],
            "practiceItems": [],
        }
        normalized = self.s.normalize_analysis_payload(raw)
        self.assertEqual(normalized["knowledgeEntries"][0]["examPriority"], 80, "模型输出中文「高」必须映射为数值优先级而不是崩溃")
        self.assertEqual(normalized["reciteItems"][0]["examPriority"], 50)
        self.assertEqual(normalized["reciteItems"][0]["difficulty"], 3)
        self.assertEqual(normalized["reciteItems"][0]["estimateSeconds"], 45, "带修饰的数字必须提取数值部分")

    def test_practice_options_normalize_dict_shapes_to_text(self):
        raw = {
            "practiceItems": [{
                "stem": "下列哪项正确", "questionType": "choice",
                "options": [{"key": "A", "value": "利他主义价值观"}, {"key": "B", "value": "宗教教义"}, "纯文本选项"],
                "referenceAnswer": "A",
            }],
        }
        normalized = self.s.normalize_analysis_payload(raw)
        self.assertEqual(
            normalized["practiceItems"][0]["options"],
            ["利他主义价值观", "宗教教义", "纯文本选项"],
            "对象形态的选项必须转成纯文本，学生端不能把 {'key':...} 原始结构渲染出来",
        )

    def test_course_mode_roundtrip_and_validation(self):
        student_id = "student-cmode-01"
        self._student(student_id, "13800000050")
        result = self.s.update_student_profile({"studentId": student_id, "displayName": "课程门数学员", "courseMode": "single"})
        self.assertEqual(result["courseMode"], "single")
        profile = self.s.student_profile(student_id)
        self.assertEqual(profile["courseMode"], "single", "档案必须读回课程门数")
        with self.assertRaises(ValueError, msg="非法课程门数必须拒绝"):
            self.s.update_student_profile({"studentId": student_id, "displayName": "课程门数学员", "courseMode": "triple"})
        unchanged = self.s.update_student_profile({"studentId": student_id, "displayName": "课程门数学员"})
        self.assertEqual(unchanged["courseMode"], "single", "未提交 courseMode 的编辑必须保留原值")

    def test_school_badge_requires_session_and_caches(self):
        self._env("YANBAN_LOCAL_TEST_MODE", "0")
        base = self._start_http()
        status, _, _ = self._http(base, "GET", "/api/school-badge?school=%E5%8D%8E%E4%B8%AD%E5%B8%88%E8%8C%83%E5%A4%A7%E5%AD%A6")
        self.assertEqual(status, 401, "未登录不得取校徽")

        class StubSearXNG(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path.startswith("/search"):
                    body = json.dumps({"results": [{"title": "华中师范大学校徽", "url": f"http://127.0.0.1:{self.server.server_address[1]}/school-page"}]}).encode("utf-8")
                    content_type = "application/json"
                elif self.path.startswith("/school-page"):
                    body = b'<html><body><img src="/badge.png"></body></html>'
                    content_type = "text/html"
                else:
                    body = b"\x89PNG\r\n\x1a\n" + b"0" * 512
                    content_type = "image/png"
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_HEAD(self):
                self.send_response(200)
                self.send_header("Content-Type", "image/png")
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *args):
                return

        self.s.ensure_data_dirs()
        stub = self.s.YanbanHTTPServer(("127.0.0.1", 0), StubSearXNG)
        threading.Thread(target=stub.serve_forever, daemon=True).start()
        self.addCleanup(lambda: (stub.shutdown(), stub.server_close()))
        with self.s.open_database() as connection:
            connection.execute(
                "INSERT INTO platform_settings(key, value, updated_at) VALUES('searxng_base_url', ?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (f"http://127.0.0.1:{stub.server_address[1]}", self.s.utc_now()),
            )
        student_id = "student-badge-01"
        self._student(student_id, "13800000051")
        token = self.s.student_login({"phone": "13800000051", "password": "correct horse battery"})["sessionToken"]
        status, body, _ = self._http(base, "GET", "/api/school-badge?school=%E5%8D%8E%E4%B8%AD%E5%B8%88%E8%8C%83%E5%A4%A7%E5%AD%A6", token=token)
        self.assertEqual(status, 200)
        badge_url = str(body.get("badgeUrl") or "")
        self.assertIn("school-badge-image", badge_url, "找到校徽后应下载到本站并返回本站图片地址")
        # 图片地址必须无需登录即可读取（<img> 标签无法携带会话头）。
        with urllib.request.urlopen(base + "/" + badge_url, timeout=10) as response:
            self.assertEqual(response.status, 200, "校徽图片必须能直接打开")
            self.assertIn("image/", response.headers.get("Content-Type") or "")
        with self.s.open_database() as connection:
            cached = connection.execute("SELECT value FROM platform_settings WHERE key='school_badge:华中师范大学'").fetchone()
        self.assertIsNotNone(cached, "校徽检索结果必须落缓存，避免重复联网")

    def test_school_badge_prefetch_caches_known_schools(self):
        self._env("YANBAN_LOCAL_TEST_MODE", "0")
        base = self._start_http()
        status, _, _ = self._http(base, "POST", "/api/admin/school-badges/prefetch", payload={})
        self.assertEqual(status, 401, "未登录管理员不得触发校徽预抓")

        class StubSearXNG(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path.startswith("/search"):
                    body = json.dumps({"results": [{"title": "校徽", "url": f"http://127.0.0.1:{self.server.server_address[1]}/school-page"}]}).encode("utf-8")
                    content_type = "application/json"
                elif self.path.startswith("/school-page"):
                    body = b'<html><body><img src="/badge.png"></body></html>'
                    content_type = "text/html"
                else:
                    body = b"\x89PNG\r\n\x1a\n" + b"0" * 512
                    content_type = "image/png"
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_HEAD(self):
                self.send_response(200)
                self.send_header("Content-Type", "image/png")
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *args):
                return

        self.s.ensure_data_dirs()
        stub = self.s.YanbanHTTPServer(("127.0.0.1", 0), StubSearXNG)
        threading.Thread(target=stub.serve_forever, daemon=True).start()
        self.addCleanup(lambda: (stub.shutdown(), stub.server_close()))
        with self.s.open_database() as connection:
            connection.execute(
                "INSERT INTO platform_settings(key, value, updated_at) VALUES('searxng_base_url', ?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (f"http://127.0.0.1:{stub.server_address[1]}", self.s.utc_now()),
            )
        result = self.s.prefetch_school_badges()
        self.assertEqual(result["found"], result["total"], "预抓应覆盖清单内全部院校（含学生档案里出现过的）")
        self.assertEqual(result["missed"], [])
        progress = self.s.school_badge_prefetch_progress()
        self.assertEqual(progress["status"], "done", "预抓进度必须落库可查")
        with self.s.open_database() as connection:
            cached = connection.execute("SELECT COUNT(*) AS c FROM platform_settings WHERE key LIKE 'school_badge:%'").fetchone()
        self.assertGreaterEqual(cached["c"], len(self.s.COMMON_SCHOOLS), "清单院校的校徽必须全部写入缓存")

    def test_school_official_domain_from_model_and_cached(self):
        original = self.s.call_model_text
        calls = []

        def fake_model(system, user, role="text"):
            calls.append(user)
            return "华中师范大学的官网是 www.ccnu.edu.cn 。"

        self.s.call_model_text = fake_model
        try:
            self.assertEqual(self.s.school_official_domain("华中师范大学"), "www.ccnu.edu.cn")
            self.assertEqual(self.s.school_official_domain("华中师范大学"), "www.ccnu.edu.cn")
        finally:
            self.s.call_model_text = original
        self.assertEqual(len(calls), 1, "官网域名必须落缓存，第二次不得再调用模型")

    def test_analysis_failed_notification_dedupes_unread(self):
        student_id = "student-dedup-01"
        self._student(student_id, "13800000060")
        self.s.upsert_course_entitlement(student_id, "course-1", "政治", "active", "test")
        message = "本次学习分析未完成，已保留上次可用结果，可在分析中心查看原因并重试。"
        self.s.push_student_notification(student_id, "analysis_failed", message, "course-1")
        with self.s.open_database() as connection:
            first = connection.execute("SELECT id, created_at FROM student_notifications WHERE student_id=?", (student_id,)).fetchone()
        self.s.push_student_notification(student_id, "analysis_failed", message, "course-1")
        with self.s.open_database() as connection:
            rows = connection.execute("SELECT id, created_at FROM student_notifications WHERE student_id=?", (student_id,)).fetchall()
        self.assertEqual(len(rows), 1, "连续两次同类型同标题同内容的通知只能产生一条记录")
        self.assertEqual(rows[0]["id"], first["id"], "去重必须复用原通知记录而不是另起一条")
        self.assertGreaterEqual(rows[0]["created_at"], first["created_at"], "去重时应刷新原记录时间使其浮到收信箱最上面")
        unread = [item for item in self.s.student_notifications(student_id, course_key="course-1")["notifications"] if not item["readAt"]]
        self.assertEqual(len(unread), 1, "学生端未读通知只能看到一条")
        # 已读之后再次发生同类事件必须重新插入，否则学生收不到新的失败提醒。
        self.s.mark_student_notification_read(student_id, rows[0]["id"], "course-1")
        self.s.push_student_notification(student_id, "analysis_failed", message, "course-1")
        with self.s.open_database() as connection:
            count = connection.execute("SELECT COUNT(*) AS c FROM student_notifications WHERE student_id=?", (student_id,)).fetchone()
        self.assertEqual(count["c"], 2, "已读通知不参与去重，新事件必须重新落一条")
        # 同类型同（空）标题但正文不同的生命周期通知不得被合并（如申请通过/收回）。
        self.s.push_student_notification(student_id, "course_request", "你的第一门专业课申请已通过，可以进入学习空间。", "course-1")
        self.s.push_student_notification(student_id, "course_request", "你的第一门专业课权限已被收回，历史学习记录已保留。", "course-1")
        kinds = [item["kind"] for item in self.s.student_notifications(student_id, course_key="course-1")["notifications"]]
        self.assertEqual(kinds.count("course_request"), 2, "正文不同的通知必须各自保留")

    def test_knowledge_base_overview_filters_by_query(self):
        self._student("student-kb-01", "13800000061")
        self._student("student-kb-02", "13800000062")
        self.s.update_student_profile({"studentId": "student-kb-01", "displayName": "张三", "targetSchool": "华中师范大学", "targetMajor": "政治学"})
        self.s.update_student_profile({"studentId": "student-kb-02", "displayName": "李四", "targetSchool": "武汉大学", "targetMajor": "英语语言文学"})
        self._write_index([
            {"id": "doc-kb-01", "name": "政治学原理笔记.txt", "kind": "text", "studentId": "student-kb-01", "courseName": "政治学原理", "subjectCode": "701", "status": "parsed"},
            {"id": "doc-kb-02", "name": "英语综合讲义.txt", "kind": "text", "studentId": "student-kb-02", "courseName": "英语综合", "subjectCode": "211", "status": "parsed"},
        ])
        self.assertEqual(len(self.s.knowledge_base_overview()), 2, "q 为空时必须保持原有行为返回全部条目")
        by_school = self.s.knowledge_base_overview("华中师范")
        self.assertEqual([entry["school"] for entry in by_school], ["华中师范大学"], "按学校子串过滤")
        by_code = self.s.knowledge_base_overview("701")
        self.assertEqual([entry["course"] for entry in by_code], ["政治学原理"], "按科目代码过滤")
        by_student = self.s.knowledge_base_overview("李四")
        self.assertEqual(len(by_student), 1, "按学生姓名过滤")
        self.assertEqual(by_student[0]["assets"][0]["student"], "李四")
        by_course = self.s.knowledge_base_overview("英语")
        self.assertEqual([entry["major"] for entry in by_course], ["英语语言文学"], "按专业课名/专业过滤")
        self.assertEqual(self.s.knowledge_base_overview("不存在的学校"), [], "无匹配时必须返回空列表")
        # 路由层：q 查询参数必须真正传到过滤逻辑，且仍要求管理员身份。
        self._env("YANBAN_LOCAL_TEST_MODE", "0")
        self._env("YANBAN_ADMIN_TOKEN", "test-admin-token-0123456789")
        base = self._start_http()
        status, body, _ = self._http(base, "GET", "/api/admin/knowledge-base?q=701")
        self.assertEqual(status, 401)
        self.assertEqual(body.get("error"), "admin_unauthorized")
        status, body, _ = self._http(base, "GET", "/api/admin/knowledge-base?q=701", token="test-admin-token-0123456789")
        self.assertEqual(status, 200)
        self.assertEqual([entry["course"] for entry in body["entries"]], ["政治学原理"], "HTTP 路由必须按 q 过滤")
        status, body, _ = self._http(base, "GET", "/api/admin/knowledge-base", token="test-admin-token-0123456789")
        self.assertEqual(len(body["entries"]), 2, "不带 q 时必须返回全部条目")

    def test_admin_document_download_requires_admin_and_serves_bytes(self):
        self._env("YANBAN_LOCAL_TEST_MODE", "0")
        self._env("YANBAN_ADMIN_TOKEN", "test-admin-token-0123456789")
        student_id = "student-dl-01"
        self._student(student_id, "13800000063")
        self.s.ensure_data_dirs()
        document_id = "doc-download01"
        content = "考研专业课笔记内容".encode("utf-8")
        (self.s.UPLOAD_DIR / f"{document_id}-复习资料.txt").write_bytes(content)
        self._write_index([
            {"id": document_id, "name": "复习资料.txt", "kind": "text", "mimeType": "text/plain", "studentId": student_id, "courseKey": "course-1", "courseName": "政治", "status": "parsed", "chunks": []},
            {"id": "doc-nofile001", "name": "缺失.txt", "kind": "text", "studentId": student_id, "courseKey": "course-1", "courseName": "政治", "status": "parsed", "chunks": []},
        ])
        base = self._start_http()
        status, body, _ = self._http(base, "GET", f"/api/admin/documents/{document_id}/download")
        self.assertEqual(status, 401)
        self.assertEqual(body.get("error"), "admin_unauthorized", "非管理员不得下载学生资料")
        request = urllib.request.Request(f"{base}/api/admin/documents/{document_id}/download")
        request.add_header("Authorization", "Bearer test-admin-token-0123456789")
        with urllib.request.urlopen(request, timeout=10) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.read(), content, "下载字节必须与上传文件完全一致")
            self.assertIn("text/plain", response.headers.get("Content-Type") or "")
            disposition = response.headers.get("Content-Disposition") or ""
        self.assertTrue(disposition.startswith("attachment; filename*=UTF-8''"), "必须以附件形式返回 RFC 5987 编码的原始文件名")
        self.assertEqual(urllib.parse.unquote(disposition.removeprefix("attachment; filename*=UTF-8''")), "复习资料.txt")
        status, body, _ = self._http(base, "GET", "/api/admin/documents/doc-missing01/download", token="test-admin-token-0123456789")
        self.assertEqual(status, 404, "不存在的文档必须返回 404")
        self.assertEqual(body.get("error"), "not_found")
        status, body, _ = self._http(base, "GET", "/api/admin/documents/doc-nofile001/download", token="test-admin-token-0123456789")
        self.assertEqual(status, 404, "记录存在但文件已丢失时同样返回 404 JSON")
        self.assertEqual(body.get("error"), "not_found")

    def test_searxng_search_retries_once_when_first_result_empty(self):
        calls = {"count": 0}
        state = {"always_empty": False}

        class StubSearXNG(BaseHTTPRequestHandler):
            def do_GET(self):
                calls["count"] += 1
                results = [] if state["always_empty"] or calls["count"] == 1 else [{"title": "恢复后结果", "url": "https://example.com/b", "content": "内容"}]
                body = json.dumps({"results": results}).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                return

        self.s.ensure_data_dirs()
        stub = self.s.YanbanHTTPServer(("127.0.0.1", 0), StubSearXNG)
        threading.Thread(target=stub.serve_forever, daemon=True).start()
        self.addCleanup(lambda: (stub.shutdown(), stub.server_close()))
        with self.s.open_database() as connection:
            connection.execute(
                "INSERT INTO platform_settings(key, value, updated_at) VALUES('searxng_base_url', ?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (f"http://127.0.0.1:{stub.server_address[1]}", self.s.utc_now()),
            )
        with patch("time.sleep") as sleep_mock:
            rows = self.s.searxng_search("测试查询", "unit-test", 2)
        self.assertEqual(calls["count"], 2, "首次为空必须隔 2 秒再查一次")
        sleep_mock.assert_called_once_with(2)
        self.assertEqual([row["url"] for row in rows], ["https://example.com/b"], "重试成功必须返回第二次查询的结果")
        state["always_empty"] = True
        calls["count"] = 0
        with patch("time.sleep") as sleep_mock:
            rows = self.s.searxng_search("测试查询", "unit-test", 2)
        self.assertEqual(rows, [], "重试后仍为空才返回空列表")
        self.assertEqual(calls["count"], 2, "只允许重试一次，不得无限循环")
        sleep_mock.assert_called_once_with(2)

    def test_web_search_health_mentions_captcha_recovery(self):
        state = {"empty": False}

        class StubSearXNG(BaseHTTPRequestHandler):
            def do_GET(self):
                results = [] if state["empty"] else [{"title": "示例", "url": "https://example.com/a", "content": "内容"}]
                body = json.dumps({"results": results}).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                return

        self.s.ensure_data_dirs()
        stub = self.s.YanbanHTTPServer(("127.0.0.1", 0), StubSearXNG)
        threading.Thread(target=stub.serve_forever, daemon=True).start()
        self.addCleanup(lambda: (stub.shutdown(), stub.server_close()))
        with self.s.open_database() as connection:
            connection.execute(
                "INSERT INTO platform_settings(key, value, updated_at) VALUES('searxng_base_url', ?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (f"http://127.0.0.1:{stub.server_address[1]}", self.s.utc_now()),
            )
        check = self.s.test_tavily_connection()
        self.assertEqual(check["provider"], "searxng")
        self.assertIn("验证码", check["message"], "健康检查返回消息必须说明验证码限流会自行恢复")
        self.assertIn("不影响模型分析主流程", check["message"])
        state["empty"] = True
        with patch("time.sleep"):
            with self.assertRaises(RuntimeError) as ctx:
                self.s.test_tavily_connection()
        self.assertIn("验证码临时限流", str(ctx.exception), "失败消息同样要说明限流会自动恢复")
        self.assertIn("不影响模型分析主流程", str(ctx.exception))

    def test_admin_student_detail_includes_plan_and_mindmap(self):
        student_id = "student-detail-03"
        other_id = "student-detail-04"
        self._student(student_id, "13800000064")
        self._student(other_id, "13800000065")
        self.s.upsert_course_entitlement(student_id, "course-1", "政治", "active", "test")
        self.s.upsert_course_entitlement(other_id, "course-1", "英语", "active", "test")
        today = self.s.datetime.now(self.s.CHINA_TIMEZONE).date()
        future = (today + self.s.timedelta(days=3)).isoformat()
        past = (today - self.s.timedelta(days=5)).isoformat()
        workspace = {
            "subject": "政治",
            "plan": {"minutes": 120, "mode": "第一轮 · 理解背诵", "restDay": "周日"},
            "planResult": {"daysPlan": [
                {"date": past, "minutes": 60, "tasks": [{"title": "过期任务", "minutes": 60}]},
                {"date": future, "minutes": 90, "tasks": [{"title": "背诵实践观", "minutes": 45, "taskKind": "new_learning"}, {"title": "回忆认识论", "minutes": 45, "taskKind": "active_recall"}]},
            ]},
            "mapNodes": ["实践观", "认识论"],
            "mapEdges": [{"from": "实践观", "to": "认识论"}],
            "mapNodeDetails": [{"title": "实践观", "summary": "核心概念"}],
            "mapMeta": {"generatedAt": "2026-09-01"},
        }
        other_workspace = {
            "subject": "英语",
            "planResult": {"daysPlan": [{"date": future, "minutes": 30, "tasks": [{"title": "他人任务", "minutes": 30}]}]},
            "mapNodes": ["他人节点"],
            "mapEdges": [],
        }
        now = self.s.utc_now()
        with self.s.open_database() as connection:
            connection.execute("INSERT INTO student_course_workspaces(student_id, course_key, workspace_json, updated_at) VALUES (?, ?, ?, ?)", (student_id, "course-1", json.dumps(workspace, ensure_ascii=False), now))
            connection.execute("INSERT INTO student_course_workspaces(student_id, course_key, workspace_json, updated_at) VALUES (?, ?, ?, ?)", (other_id, "course-1", json.dumps(other_workspace, ensure_ascii=False), now))
        detail = self.s.admin_student_detail(student_id)
        content = detail["content"]["course-1"]
        plan = content["plan"]
        self.assertEqual(plan["mode"], "第一轮 · 理解背诵")
        self.assertEqual([day["date"] for day in plan["days"]], [future], "教师端只看未来 30 天任务，历史日期不得出现")
        self.assertEqual([task["title"] for task in plan["days"][0]["tasks"]], ["背诵实践观", "回忆认识论"])
        mindmap = content["mindmap"]
        self.assertEqual(mindmap["mapNodes"], ["实践观", "认识论"], "思维导图节点必须出现在学生详情里")
        self.assertEqual(mindmap["mapEdges"], [{"from": "实践观", "to": "认识论"}], "思维导图边必须出现在学生详情里")
        serialized = json.dumps(detail, ensure_ascii=False)
        self.assertNotIn("他人任务", serialized, "其他学生的计划不得混入")
        self.assertNotIn("他人节点", serialized, "其他学生的思维导图不得混入")


if __name__ == "__main__":
    unittest.main()
