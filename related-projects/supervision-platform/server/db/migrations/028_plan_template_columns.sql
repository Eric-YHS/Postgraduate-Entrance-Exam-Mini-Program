-- 复习计划模板增加任务列定义（前端模板表格的列头，如 任务1/任务2/自定义）。
ALTER TABLE plan_templates ADD COLUMN IF NOT EXISTS columns jsonb NOT NULL DEFAULT '[]'::jsonb;
