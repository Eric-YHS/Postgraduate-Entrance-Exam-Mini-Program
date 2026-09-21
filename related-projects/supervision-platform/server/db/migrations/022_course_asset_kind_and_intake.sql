-- 课程附件区分视频与配套资料；学员信息采集记录提交时间。
ALTER TABLE course_assets
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'material' CHECK (kind IN ('video','material'));

ALTER TABLE students
  ADD COLUMN IF NOT EXISTS intake_submitted_at timestamptz;
