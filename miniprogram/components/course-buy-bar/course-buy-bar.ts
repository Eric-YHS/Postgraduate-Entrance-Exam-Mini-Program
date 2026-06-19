import { formatPrice as formatPriceUtil } from '../../utils/course';
import type { CourseDetail } from '../../types/course';

Component({
  properties: {
    course: {
      type: Object,
      value: undefined,
    },
  },

  data: {
    buttonText: '',
    subText: '',
    showPrice: false,
  },

  lifetimes: {
    attached() {
      this.updateButtonState();
    },
  },

  observers: {
    course() {
      this.updateButtonState();
    },
  },

  methods: {
    updateButtonState() {
      const course = this.data.course as CourseDetail | null;
      if (!course) return;

      if (course.isFree) {
        this.setData({ buttonText: '免费学习', subText: '', showPrice: false });
        return;
      }

      if (course.isPurchased) {
        this.setData({ buttonText: '继续学习', subText: '已解锁全部内容', showPrice: false });
        return;
      }

      this.setData({
        buttonText: '立即购买',
        subText: `原价 ¥${formatPriceUtil(course.originalPrice)}`,
        showPrice: true,
      });
    },

    onButtonTap() {
      const course = this.data.course as CourseDetail | null;
      if (!course) return;

      if (course.isFree || course.isPurchased) {
        this.triggerEvent('startlearning');
      } else {
        this.triggerEvent('buy');
      }
    },

    formatPrice(price: number): string {
      return formatPriceUtil(price);
    },
  },
});
