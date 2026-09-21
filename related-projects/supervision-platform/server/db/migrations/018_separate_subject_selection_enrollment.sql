-- student_subjects 的“存在”表示学员自主选择的报考科目；enrolled 仅表示老师/销售确认的报名及进阶功能权限。
-- 旧版本中学生选择科目会直接写入 enrolled=true，无法可靠区分历史来源。
-- 为避免未核实报名而继续开放进阶功能，迁移后统一改为未确认，由老师在学员档案中逐科确认。
UPDATE student_subjects
SET enrolled = false
WHERE enrolled IS DISTINCT FROM false;
