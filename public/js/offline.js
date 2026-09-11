// カード登録画面をオフライン対応にする。
// ・Wi-Fiが無いときは端末内（localStorage）に一時保存
// ・Wi-Fiに繋がった時点で自動的にサーバーへ送信
(function () {
  const QUEUE_KEY = 'mushijingi_pending_cards';

  function getQueue() {
    try {
      return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
    } catch (e) {
      return [];
    }
  }
  function setQueue(list) {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(list));
  }

  function renderStatus(el) {
    if (!el) return;
    const q = getQueue();
    if (q.length === 0) {
      el.hidden = true;
      el.textContent = '';
    } else {
      el.hidden = false;
      el.textContent = `オフラインで保存中：${q.length}件（Wi-Fiに繋がると自動で登録されます）`;
    }
  }

  async function trySync(statusEl) {
    if (!navigator.onLine) return;
    const q = getQueue();
    if (q.length === 0) return;
    const remaining = [];
    for (const body of q) {
      try {
        const res = await fetch('/cards', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
        });
        if (!res.ok) remaining.push(body);
      } catch (e) {
        remaining.push(body);
      }
    }
    setQueue(remaining);
    renderStatus(statusEl);
  }

  document.addEventListener('DOMContentLoaded', () => {
    const form = document.querySelector('form[data-offline-capable]');
    if (!form) return;

    const statusEl = document.createElement('div');
    statusEl.className = 'offline-status';
    form.parentNode.insertBefore(statusEl, form);
    renderStatus(statusEl);
    trySync(statusEl);

    window.addEventListener('online', () => trySync(statusEl));

    let bypassIntercept = false;

    form.addEventListener('submit', async (e) => {
      if (bypassIntercept) {
        bypassIntercept = false;
        return; // 入力エラー時：通常のフォーム送信に任せてサーバー側のエラー表示を使う
      }
      e.preventDefault();
      const body = new URLSearchParams(new FormData(form)).toString();

      try {
        const res = await fetch('/cards', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
        });
        if (res.status === 400) {
          bypassIntercept = true;
          form.submit();
          return;
        }
        if (res.ok) {
          window.location.href = '/cards';
          return;
        }
        throw new Error('save failed: ' + res.status);
      } catch (err) {
        // 通信できない＝オフライン。端末内に保存して、次に繋がったときに自動送信する
        const q = getQueue();
        q.push(body);
        setQueue(q);
        renderStatus(statusEl);
        form.reset();
        alert('オフラインのため、この端末に保存しました。Wi-Fiに繋がったら自動で登録されます。');
      }
    });
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register('/sw.js')
        .then(() => {
          try { localStorage.setItem('sw_reg_error', ''); } catch (e) {}
        })
        .catch((err) => {
          try {
            localStorage.setItem('sw_reg_error', (err && err.name ? err.name + ': ' : '') + (err && err.message ? err.message : String(err)));
          } catch (e) {}
        });
    });
  }
})();
