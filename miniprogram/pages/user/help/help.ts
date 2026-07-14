Page({
  data: {
    expandedIndex: -1,
    faqs: [
      {
        question: '题库和错题本如何使用？',
        answer: '从首页或“我的题库”进入练习。答错的题目会记录到错题本，掌握后可以在错题本中标记为已掌握。',
      },
      {
        question: '如何发布帖子？',
        answer: '进入论坛后点击发布按钮，填写正文，可按需添加图片、视频、附件和话题标签，再点击底部“发布”。',
      },
      {
        question: '为什么当前没有课程入口？',
        answer: '在线课程和视频功能暂未开放。题库、错题本、学习计划、答疑和论坛等当前功能仍可免费使用。',
      },
      {
        question: '学习数据保存在哪里？',
        answer: '练习进度、错题和学习计划默认保存在当前设备。可在“设置”中查看存储占用或清理本地学习数据。',
      },
    ],
  },

  onToggleFaq(e: WechatMiniprogram.BaseEvent) {
    const index = Number(e.currentTarget.dataset.index);
    this.setData({ expandedIndex: this.data.expandedIndex === index ? -1 : index });
  },
});
