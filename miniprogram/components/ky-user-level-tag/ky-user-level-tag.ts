import { UserLevel } from '../../types/user';
import { getLevelConfig } from '../../utils/permission';

Component({
  properties: {
    level: {
      type: String,
      value: UserLevel.FREE,
    },
    showIcon: {
      type: Boolean,
      value: false,
    },
  },
  data: {
    label: '',
    color: '',
    bg: '',
  },
  lifetimes: {
    attached() {
      this.updateStyle();
    },
  },
  observers: {
    level() {
      this.updateStyle();
    },
  },
  methods: {
    updateStyle() {
      const config = getLevelConfig(this.data.level as UserLevel);
      this.setData({
        label: config.label,
        color: config.color,
        bg: config.bg,
      });
    },
  },
});
