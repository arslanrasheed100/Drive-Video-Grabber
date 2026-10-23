'use strict';

/**
 * Donation dialog. Loaded by the popup and the merge page after the markup.
 * Addresses are copied with a user gesture; if the clipboard is unavailable,
 * the address text is selected so it can be copied by hand.
 */
(() => {
  const dialog = document.getElementById('donateDialog');
  const openBtn = document.getElementById('donateBtn');
  if (!dialog || !openBtn) return;

  const closeBtn = document.getElementById('donateClose');

  const open = () => {
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  };

  const close = () => {
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  };

  openBtn.addEventListener('click', open);
  if (closeBtn) closeBtn.addEventListener('click', close);

  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) close();
  });

  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      /* clipboard permission or API unavailable, try the old path */
    }

    const box = document.createElement('textarea');
    box.value = text;
    box.setAttribute('readonly', '');
    box.style.position = 'fixed';
    box.style.top = '-1000px';
    box.style.opacity = '0';
    document.body.appendChild(box);
    box.select();

    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (_) {
      ok = false;
    }
    box.remove();
    return ok;
  };

  dialog.querySelectorAll('[data-copy]').forEach((btn) => {
    const address = btn.getAttribute('data-copy');
    const original = btn.textContent;

    btn.addEventListener('click', async () => {
      const ok = await copyText(address);
      btn.textContent = ok ? 'Copied' : 'Select and copy';
      btn.classList.toggle('copied', ok);

      if (!ok) {
        const row = btn.closest('.donate-row');
        const code = row && row.querySelector('code');
        if (code) {
          const range = document.createRange();
          range.selectNodeContents(code);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        }
      }

      setTimeout(() => {
        btn.textContent = original;
        btn.classList.remove('copied');
      }, 1600);
    });
  });
})();
