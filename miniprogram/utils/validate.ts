/** 校验手机号 */
export function isPhone(phone: string): boolean {
  return /^1[3-9]\d{9}$/.test(phone);
}

/** 校验邮箱 */
export function isEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** 校验非空 */
export function isNotEmpty(value: string | unknown[] | undefined | null): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/** 校验长度范围 */
export function isLengthValid(value: string, min: number, max: number): boolean {
  const len = value.trim().length;
  return len >= min && len <= max;
}

/** 校验身份证号码（简易） */
export function isIdCard(idCard: string): boolean {
  return /^\d{17}[\dXx]$/.test(idCard) || /^\d{15}$/.test(idCard);
}

/** 通用表单校验规则 */
export interface ValidationRule {
  field: string;
  label: string;
  required?: boolean;
  min?: number;
  max?: number;
  phone?: boolean;
  email?: boolean;
  idCard?: boolean;
  validator?: (value: unknown) => boolean | string;
}

/** 执行表单校验，返回第一个错误信息或 null */
export function validateForm(data: Record<string, unknown>, rules: ValidationRule[]): string | null {
  for (const rule of rules) {
    const value = data[rule.field];

    if (rule.required && !isNotEmpty(value as string | unknown[] | undefined | null)) {
      return `${rule.label}不能为空`;
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();

      if (rule.min !== undefined || rule.max !== undefined) {
        const min = rule.min ?? 0;
        const max = rule.max ?? Infinity;
        if (trimmed.length < min || trimmed.length > max) {
          return `${rule.label}长度需在 ${min} 到 ${max} 之间`;
        }
      }

      if (rule.phone && !isPhone(trimmed)) {
        return `${rule.label}格式不正确`;
      }

      if (rule.email && !isEmail(trimmed)) {
        return `${rule.label}格式不正确`;
      }

      if (rule.idCard && !isIdCard(trimmed)) {
        return `${rule.label}格式不正确`;
      }
    }

    if (rule.validator) {
      const result = rule.validator(value);
      if (result !== true) {
        return typeof result === 'string' ? result : `${rule.label}校验失败`;
      }
    }
  }

  return null;
}
