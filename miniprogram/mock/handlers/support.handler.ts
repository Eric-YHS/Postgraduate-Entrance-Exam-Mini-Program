export interface SupportAnswer {
  answer: string;
}

/** 审核版本的本地自助答疑，避免依赖未配置的外部服务。 */
export function mockAnswerQuestion(data: Record<string, unknown>): Promise<SupportAnswer> {
  const question = String(data.question || '').trim();
  if (!question) {
    return Promise.reject(new Error('请输入问题'));
  }

  if (/课程|视频|网课/.test(question)) {
    return Promise.resolve({
      answer: '在线课程与视频功能当前暂未开放。你仍可免费使用题库、错题本、学习计划和论坛交流功能。',
    });
  }

  if (/报名|考试时间|准考证/.test(question)) {
    return Promise.resolve({
      answer: '报名与考试时间请以中国研究生招生信息网及目标院校最新公告为准，避免使用过期信息。',
    });
  }

  if (/题库|错题|刷题/.test(question)) {
    return Promise.resolve({
      answer: '可从首页进入题库开始练习；答错的题目会进入错题本，掌握后可在错题本中标记为已掌握。',
    });
  }

  if (/计划|安排|复习/.test(question)) {
    return Promise.resolve({
      answer: '建议把目标拆成当天可完成的小任务，并在“我的－学习计划”中逐项记录和完成。',
    });
  }

  return Promise.resolve({
    answer: '建议先明确问题中的已知条件、目标和已经尝试过的方法。若仍无法解决，可到论坛发布具体问题并补充相关背景。',
  });
}
