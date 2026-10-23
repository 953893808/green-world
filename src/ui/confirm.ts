import { escapeHtml } from './dom';

/**
 * 自绘确认框。
 *
 * 为什么不用 window.confirm：移动端 webview 里它经常被抑制或样式不可控，
 * 而且内嵌 webview 页面弹出原生对话框的体验很差。这里用一层独立 DOM，
 * 不参与任何重绘（挂在 body 上），因此不会因为 innerHTML 重绘而丢。
 *
 * 测试环境（node）没有 document，因此提供 impl 注入口，
 * 纯逻辑测试不需要 jsdom。
 */

export interface ConfirmOptions {
  title: string;
  message?: string;
  okText?: string;
  cancelText?: string;
  /** 危险操作（删除档等）用红色确认按钮 */
  danger?: boolean;
}

type ConfirmImpl = (options: ConfirmOptions) => Promise<boolean>;

let impl: ConfirmImpl | null = null;

/** 测试注入：把对话框换成假实现；传 null 恢复真实实现 */
export function setConfirmImpl(next: ConfirmImpl | null): void {
  impl = next;
}

export function askConfirm(options: ConfirmOptions): Promise<boolean> {
  if (impl) return impl(options);
  if (typeof document === 'undefined') return Promise.resolve(false);
  return domConfirm(options);
}

function domConfirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal';
    overlay.innerHTML = `
      <div class="modal__box" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <b id="modal-title">${escapeHtml(options.title)}</b>
        ${options.message ? `<div class="small dim">${escapeHtml(options.message)}</div>` : ''}
        <div class="row--wrap" style="margin-top:10px">
          <button class="btn" data-modal="cancel">${escapeHtml(options.cancelText ?? '取消')}</button>
          <button class="btn ${options.danger ? 'btn--danger' : 'btn--primary'}" data-modal="ok">${escapeHtml(options.okText ?? '确定')}</button>
        </div>
      </div>`;

    let done = false;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close(false);
    };
    const close = (value: boolean): void => {
      if (done) return;
      done = true;
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };

    overlay.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const hit = target.closest<HTMLElement>('[data-modal]');
      if (!hit) {
        if (target === overlay) close(false);
        return;
      }
      close(hit.dataset.modal === 'ok');
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    overlay.querySelector<HTMLButtonElement>('[data-modal="ok"]')?.focus();
  });
}
