/** 订阅回调 */
type Listener<T> = (state: T, prevState: T) => void;

/* eslint-disable @typescript-eslint/no-explicit-any */
/** 轻量 Store 实现 */
export class Store<T extends Record<string, any>> {
  private state: T;
  private listeners: Set<Listener<T>> = new Set();

  constructor(initialState: T) {
    this.state = initialState;
  }

  /** 获取当前状态 */
  getState(): T {
    return { ...this.state };
  }

  /** 更新状态（支持部分更新） */
  setState(partial: Partial<T>): void {
    const prevState = { ...this.state };
    this.state = { ...this.state, ...partial };
    this.listeners.forEach((listener) => listener(this.getState(), prevState));
  }

  /** 订阅状态变化 */
  subscribe(listener: Listener<T>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/** 创建 Store 实例 */
export function createStore<T extends Record<string, any>>(initialState: T): Store<T> {
  return new Store(initialState);
}
