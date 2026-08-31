/*!
 * FlyRank widget bundle.
 *
 * Served from /static/widget.<build>-<hash>.js and cached forever, because the
 * URL changes whenever this file's content does. The loader injected by
 * /widget.js?id=... sets up window.__FRW and queues the widget ids to mount.
 *
 * Two rules this file lives by, because it runs on pages we do not control:
 *
 *  1. Never use innerHTML with values from the config. Titles, labels and
 *     button text are customer-authored strings; building DOM nodes and
 *     assigning textContent means a customer cannot inject markup into their
 *     own visitors' pages through our widget.
 *  2. Never throw into the host page. A broken widget must be a widget that
 *     does not appear, not a JavaScript error in somebody else's console.
 */
(function () {
  'use strict';

  var FRW = (window.__FRW = window.__FRW || { queue: [], base: '' });
  var mounted = {};

  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var key in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, key)) node.setAttribute(key, attrs[key]);
      }
    }
    if (text != null) node.textContent = text;
    return node;
  }

  /* Scoped to a class prefix so we never collide with the host page's CSS. */
  function injectStyles() {
    if (document.getElementById('frw-styles')) return;
    var css = [
      '.frw{font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111;',
      'background:#fff;border:1px solid #d8dde3;border-radius:10px;padding:18px;max-width:360px;',
      'box-shadow:0 2px 10px rgba(0,0,0,.06);box-sizing:border-box}',
      '.frw *{box-sizing:border-box}',
      '.frw--dark{background:#161b22;color:#e6edf3;border-color:#30363d}',
      '.frw--floating{position:fixed;z-index:2147483000;width:340px}',
      '.frw--bottom-right{right:20px;bottom:20px}.frw--bottom-left{left:20px;bottom:20px}',
      '.frw--center{left:50%;top:50%;transform:translate(-50%,-50%)}',
      '.frw h3{margin:0 0 4px;font-size:16px}',
      '.frw p.frw-desc{margin:0 0 12px;color:#5b6672;font-size:13px}',
      '.frw--dark p.frw-desc{color:#9aa7b2}',
      '.frw label{display:block;margin:10px 0 4px;font-size:13px;font-weight:600}',
      '.frw input,.frw textarea,.frw select{width:100%;padding:8px 10px;border:1px solid #cbd3da;',
      'border-radius:6px;font:inherit;background:#fff;color:inherit}',
      '.frw--dark input,.frw--dark textarea,.frw--dark select{background:#0d1117;border-color:#30363d;color:#e6edf3}',
      '.frw button{margin-top:14px;width:100%;padding:9px 14px;border:0;border-radius:6px;',
      'background:#1f6feb;color:#fff;font:inherit;font-weight:600;cursor:pointer}',
      '.frw button[disabled]{opacity:.6;cursor:progress}',
      '.frw-msg{margin-top:12px;font-size:13px}',
      '.frw-msg--err{color:#b42318}.frw-msg--ok{color:#0f7b3d}',
      '.frw-err{display:block;margin-top:4px;font-size:12px;color:#b42318;font-weight:400}',
      '.frw-hp{position:absolute!important;left:-9999px!important;width:1px;height:1px;opacity:0}',
    ].join('');
    var style = el('style', { id: 'frw-styles' });
    style.appendChild(document.createTextNode(css));
    document.head.appendChild(style);
  }

  /*
   * Render inline where the customer asked for it, otherwise float above the
   * page. The inline hook is looked up by data attribute so a customer can drop
   * the form exactly where they want it without us guessing.
   */
  function containerFor(cfg) {
    var explicit =
      document.querySelector('[data-flyrank-widget="' + cfg.public_id + '"]') ||
      (cfg.display && cfg.display.container_id
        ? document.getElementById(cfg.display.container_id)
        : null);

    var box = el('div', { class: 'frw', 'data-frw-id': cfg.public_id });
    if (cfg.display && cfg.display.theme === 'dark') box.className += ' frw--dark';

    if (explicit) {
      explicit.appendChild(box);
      return box;
    }

    var position = (cfg.display && cfg.display.position) || 'inline';
    if (position !== 'inline') box.className += ' frw--floating frw--' + position;
    document.body.appendChild(box);
    return box;
  }

  function buildInput(field) {
    var id = 'frw-' + field.name;
    var node;

    if (field.type === 'textarea') {
      node = el('textarea', { rows: '3' });
    } else if (field.type === 'select') {
      node = el('select');
      node.appendChild(el('option', { value: '' }, field.placeholder || 'Choose…'));
      (field.options || []).forEach(function (option) {
        node.appendChild(el('option', { value: option }, option));
      });
    } else if (field.type === 'checkbox') {
      node = el('input', { type: 'checkbox' });
    } else {
      node = el('input', { type: field.type === 'number' ? 'number' : field.type });
    }

    node.id = id;
    node.name = field.name;
    if (field.placeholder && field.type !== 'select') node.placeholder = field.placeholder;
    if (field.max_length && node.tagName !== 'SELECT') node.maxLength = field.max_length;
    if (field.required) node.required = true;
    return node;
  }

  function readValue(field, node) {
    if (field.type === 'checkbox') return node.checked;
    if (field.type === 'number') return node.value === '' ? undefined : Number(node.value);
    return node.value;
  }

  function mount(publicId) {
    if (mounted[publicId]) return;
    mounted[publicId] = true;

    fetch(FRW.base + '/api/public/widgets/' + encodeURIComponent(publicId) + '/config', {
      credentials: 'omit',
    })
      .then(function (res) {
        if (!res.ok) throw new Error('config responded ' + res.status);
        return res.json();
      })
      .then(function (cfg) {
        var delay = (cfg.display && cfg.display.delay_ms) || 0;
        if (delay > 0) setTimeout(function () { render(cfg); }, delay);
        else render(cfg);
      })
      .catch(function (err) {
        // Log, never throw: the host page is not ours to break.
        if (window.console) console.warn('[flyrank-widget] could not load ' + publicId, err);
      });
  }

  function render(cfg) {
    injectStyles();
    var box = containerFor(cfg);
    var form = el('form', { novalidate: 'novalidate' });
    var inputs = {};

    box.appendChild(el('h3', null, cfg.title));
    if (cfg.description) box.appendChild(el('p', { class: 'frw-desc' }, cfg.description));

    (cfg.fields || []).forEach(function (field) {
      var label = el('label', { for: 'frw-' + field.name }, field.label + (field.required ? ' *' : ''));
      var input = buildInput(field);
      inputs[field.name] = input;
      form.appendChild(label);
      form.appendChild(input);
      form.appendChild(el('span', { class: 'frw-err', 'data-err': field.name }));
    });

    // The honeypot. Hidden from people by CSS and from screen readers by
    // aria-hidden, left in the DOM for anything that fills in every input.
    var honeypot = el('input', {
      type: 'text',
      class: 'frw-hp',
      tabindex: '-1',
      autocomplete: 'off',
      'aria-hidden': 'true',
    });
    honeypot.name = cfg.honeypot_field || '_hp';
    form.appendChild(honeypot);

    var button = el('button', { type: 'submit' }, cfg.button_text || 'Submit');
    var message = el('div', { class: 'frw-msg' });
    form.appendChild(button);
    form.appendChild(message);
    box.appendChild(form);

    // Stamped when the form is drawn; the server compares it against the clock
    // to spot a submission no human could have typed.
    var renderedAt = Date.now();

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      button.disabled = true;
      message.className = 'frw-msg';
      message.textContent = '';
      form.querySelectorAll('[data-err]').forEach(function (n) { n.textContent = ''; });

      var data = {};
      (cfg.fields || []).forEach(function (field) {
        var value = readValue(field, inputs[field.name]);
        if (value !== undefined && value !== '') data[field.name] = value;
      });

      var payload = { widget_id: cfg.public_id, data: data, rendered_at: renderedAt };
      payload[honeypot.name] = honeypot.value;

      fetch(cfg.submit_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'omit',
        body: JSON.stringify(payload),
      })
        .then(function (res) {
          return res.json().then(function (body) { return { status: res.status, body: body }; });
        })
        .then(function (result) {
          if (result.status < 300) {
            form.reset();
            message.className = 'frw-msg frw-msg--ok';
            message.textContent =
              (cfg.display && cfg.display.success_message) || 'Thanks — we got it.';
            button.disabled = false;
            return;
          }

          message.className = 'frw-msg frw-msg--err';
          if (result.status === 429) {
            message.textContent = 'Too many attempts. Please try again in a moment.';
          } else if (result.body && result.body.details && result.body.details.length) {
            // Put each server-side message next to the field it belongs to.
            message.textContent = 'Please check the highlighted fields.';
            result.body.details.forEach(function (detail) {
              var name = String(detail.field || '').replace(/^data\./, '');
              var slot = form.querySelector('[data-err="' + name + '"]');
              if (slot) slot.textContent = detail.message;
            });
          } else {
            message.textContent = (result.body && result.body.message) || 'Something went wrong.';
          }
          button.disabled = false;
        })
        .catch(function () {
          message.className = 'frw-msg frw-msg--err';
          message.textContent = 'Could not reach the server. Please try again.';
          button.disabled = false;
        });
    });
  }

  function start() {
    var pending = FRW.queue || [];
    // Replace the queue with a live mount, so a second loader arriving after
    // this bundle renders immediately instead of pushing into an array nobody
    // reads again.
    FRW.queue = { push: mount };
    pending.forEach(mount);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
