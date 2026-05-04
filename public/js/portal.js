  // ── Tab switching (public docs + authenticated console) ───────
  const CONSOLE_TAB_NAMES = ['home', 'keys', 'usage', 'sandbox'];
  const ROUTE_LABELS = {
    reference: 'API Reference',
    licensing: 'Licensing',
    home: 'Home',
    keys: 'API keys',
    usage: 'Usage',
    sandbox: 'Playground',
  };

  function updatePageMeta(tabName) {
    const label = ROUTE_LABELS[tabName] || 'Portal';
    document.title = label + ' — Amethyst Engine';
  }

  function updateNavAriaCurrent(tabName) {
    document.querySelectorAll('.sidebar-link.portal-tab-trigger').forEach(btn => {
      if (btn.dataset.tab === tabName) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    });
  }

  function navDrawerOpen() {
    return document.body.classList.contains('nav-drawer-open');
  }

  function setNavDrawerOpen(open) {
    document.body.classList.toggle('nav-drawer-open', Boolean(open));
    const menuBtn = document.getElementById('navMenuBtn');
    if (menuBtn) menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function closeNavDrawer() {
    setNavDrawerOpen(false);
  }

  function navGoHome() {
    setActiveTab('reference');
    closeNavDrawer();
  }

  function isConsoleProtected(tabName) {
    return tabName === 'home' || tabName === 'keys';
  }

  function syncChromeUi() {
    const unlocked = Boolean(accountProfile);
    document.body.classList.toggle('logged-in', unlocked);
    const gate = document.getElementById('sidebarKeysGate');
    const signed = document.getElementById('sidebarKeysSignedIn');
    if (gate) gate.hidden = unlocked;
    if (signed) signed.hidden = !unlocked;
  }

  function accountChipNavigate() {
    if (accountProfile) setActiveTab('keys');
  }

  function setActiveTab(tabName, opts) {
    if (tabName === 'organization') tabName = 'keys';
    if (isConsoleProtected(tabName) && !accountProfile) {
      tabName = 'keys';
    }
    document.querySelectorAll('.portal-tab-trigger').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.querySelectorAll('.portal-tab-trigger[data-tab="' + tabName + '"]').forEach(b => {
      b.classList.add('active');
    });
    const tab = document.getElementById('tab-' + tabName);
    if (tab) tab.classList.add('active');

    document.body.classList.toggle('console-view', CONSOLE_TAB_NAMES.includes(tabName));

    if (tabName === 'home' && accountProfile) accountRefresh();
    if (tabName === 'keys') {
      accountHideInfo();
      keysEnsureStatus();
      if (!accountProfile) {
        requestAnimationFrame(() => {
          const tab = document.getElementById('tab-keys');
          const email = document.getElementById('accountEmail');
          if (tab && tab.classList.contains('active') && email) email.focus();
        });
      }
    }
    if (tabName === 'sandbox') sandboxEnsureLoaded();

    if (!opts || !opts.skipHash) {
      try {
        if (window.history && window.history.replaceState) {
          window.history.replaceState(null, '', '#' + tabName);
        }
      } catch (_) { /* ignore */ }
    }

    updatePageMeta(tabName);
    updateNavAriaCurrent(tabName);
    document.body.dataset.portalTab = tabName;
    closeNavDrawer();
  }

  document.querySelectorAll('.portal-tab-trigger').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.tab) setActiveTab(btn.dataset.tab);
    });
  });

  window.addEventListener('hashchange', () => {
    let raw = (window.location.hash || '').replace(/^#/, '');
    if (raw === 'organization') {
      raw = 'keys';
      try {
        if (window.history && window.history.replaceState) window.history.replaceState(null, '', '#keys');
      } catch (_) { /* ignore */ }
    }
    if (!raw || !/^[\w-]+$/.test(raw)) return;
    const el = document.getElementById('tab-' + raw);
    if (el) setActiveTab(raw, { skipHash: true });
  });

  document.getElementById('navMenuBtn')?.addEventListener('click', () => {
    setNavDrawerOpen(!navDrawerOpen());
  });
  document.getElementById('navBackdrop')?.addEventListener('click', closeNavDrawer);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && navDrawerOpen()) {
      e.preventDefault();
      closeNavDrawer();
    }
  });

  // ── Endpoint expand/collapse ──────────────────────────────────
  function toggleEndpoint(id) {
    document.getElementById(id).classList.toggle('open');
  }

  // ── Copy button ───────────────────────────────────────────────
  function copyCode(btn) {
    const pre = btn.closest('.code-block').querySelector('pre');
    navigator.clipboard.writeText(pre.innerText).then(() => {
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
    });
  }

  // ── Service status check ──────────────────────────────────────
  async function checkStatus() {
    const dot = document.getElementById('statusDot');
    const txt = document.getElementById('statusText');
    try {
      const r = await fetch('/api/health');
      if (r.ok) {
        dot.className = 'dot online';
        txt.textContent = 'operational';
      } else {
        throw new Error('non-ok');
      }
    } catch {
      dot.className = 'dot offline';
      txt.textContent = 'unavailable';
    }
  }
  checkStatus();

  // ── Key visibility toggle (My Usage) ─────────────────────────
  function toggleKeyVisibility() {
    const input = document.getElementById('keyInput');
    const btn = document.getElementById('toggleKeyVisBtn');
    input.type = input.type === 'password' ? 'text' : 'password';
    const showing = input.type === 'text';
    btn.setAttribute('aria-pressed', showing ? 'true' : 'false');
    btn.setAttribute('aria-label', showing ? 'Hide API key' : 'Show API key');
    const eyeOn = btn.querySelector('.ic-eye-open');
    const eyeOff = btn.querySelector('.ic-eye-off');
    if (eyeOn && eyeOff) {
      eyeOn.style.display = showing ? 'none' : '';
      eyeOff.style.display = showing ? '' : 'none';
    }
  }

  /** Parses Express `errorHandler` JSON and other simple `{ error: string }` shapes. */
  function portalApiMessage(data) {
    if (typeof data === 'string' && data.trim()) return data.trim();
    if (!data || typeof data !== 'object') return 'Request failed';
    if (typeof data.message === 'string') return data.message;
    if (data.error && typeof data.error === 'object' && typeof data.error.message === 'string') {
      return data.error.message;
    }
    if (typeof data.error === 'string') return data.error;
    return 'Request failed';
  }

  function portalAuthTransportHint() {
    if (window.location.protocol === 'file:') {
      return 'Open the portal from the API server URL (for example http://localhost:3002) instead of file:// so session cookies can be set.';
    }
    return 'Check your API server and network connection, then try again.';
  }

  function portalLikelyWrongLocalOriginHint() {
    const host = String(window.location.hostname || '').toLowerCase();
    const port = String(window.location.port || '');
    const isLocal = host === 'localhost' || host === '127.0.0.1';
    if (!isLocal) return '';
    if (port && port !== '3002') {
      return 'This project expects the local API + portal at http://localhost:3002. You appear to be on ' + window.location.origin + '.';
    }
    if (!port) {
      return 'Use the explicit local API + portal URL http://localhost:3002 for sign-in.';
    }
    return '';
  }

  async function portalHealthMismatchHint() {
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      if (!r.ok) return '';
      const body = await portalReadResponseBody(r);
      const looksLikeAmethyst =
        body &&
        typeof body === 'object' &&
        typeof body.service === 'string' &&
        String(body.service).toLowerCase().includes('amethyst');
      if (!looksLikeAmethyst) {
        return 'The current origin responded to /api/health but does not look like this Amethyst API service. Open http://localhost:3002 instead.';
      }
    } catch {
      // ignore; fallback to generic hint
    }
    return '';
  }

  async function portalBuildAuthFailureMessage(prefix) {
    const mismatch = await portalHealthMismatchHint();
    if (mismatch) return prefix + ' ' + mismatch;
    const originHint = portalLikelyWrongLocalOriginHint();
    if (originHint) return prefix + ' ' + originHint;
    return prefix + ' ' + portalAuthTransportHint();
  }

  async function portalReadResponseBody(res) {
    const contentType = String(res.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('application/json')) {
      try {
        return await res.json();
      } catch {
        return null;
      }
    }
    try {
      const text = await res.text();
      return text ? { message: text.slice(0, 300) } : null;
    } catch {
      return null;
    }
  }

  // ── Portal account auth + key dashboard ──────────────────────
  let accountBooted = false;
  let accountProfile = null;
  let accountAuthMode = 'signin';
  syncChromeUi();

  function accountShowErr(msg) {
    accountHideInfo();
    const el = document.getElementById('accountError');
    el.textContent = msg;
    el.style.display = 'block';
  }
  function accountHideErr() {
    const el = document.getElementById('accountError');
    el.style.display = 'none';
    el.textContent = '';
  }
  function accountShowInfo(msg) {
    const errEl = document.getElementById('accountError');
    if (errEl && errEl.style.display === 'block' && String(errEl.textContent || '').trim()) return;
    const el = document.getElementById('accountInfo');
    el.textContent = msg;
    el.style.display = 'block';
  }
  function accountHideInfo() {
    const el = document.getElementById('accountInfo');
    el.style.display = 'none';
    el.textContent = '';
  }

  function accountSetMode(mode) {
    accountAuthMode = mode === 'create' ? 'create' : 'signin';
    const isCreate = accountAuthMode === 'create';
    document.getElementById('accountModeSignInBtn').classList.toggle('active', !isCreate);
    document.getElementById('accountModeCreateBtn').classList.toggle('active', isCreate);
    document.getElementById('accountDisplayNameWrap').style.display = isCreate ? '' : 'none';
    document.getElementById('accountOrgWrap').style.display = isCreate ? '' : 'none';
    const primary = document.getElementById('accountPrimaryBtn');
    primary.textContent = isCreate ? 'Create account' : 'Sign in';
    const hint = document.getElementById('accountAuthInlineHint');
    hint.textContent = isCreate
      ? 'Create a team account using your organization email. Password must include letters and a number.'
      : 'Enter your email and password to manage API keys.';
  }

  async function accountSubmitAuth() {
    if (accountAuthMode === 'create') {
      await accountRegister();
      return;
    }
    await accountLogin();
  }

  function accountRenderSignedIn(profile) {
    const authPanel = document.getElementById('accountAuthPanel');
    const signed = document.getElementById('accountSignedInPanel');
    const chip = document.getElementById('accountChipBtn');
    const summary = document.getElementById('accountSummaryRow');
    if (!profile) {
      authPanel.style.display = 'block';
      signed.style.display = 'none';
      chip.style.display = 'none';
      chip.textContent = '';
      chip.classList.remove('online');
      chip.classList.add('offline');
      summary.replaceChildren();
      const intro = document.getElementById('keysWizardIntro');
      if (intro) intro.hidden = true;
      syncChromeUi();
      return;
    }
    authPanel.style.display = 'none';
    signed.style.display = 'block';
    chip.style.display = 'inline-flex';
    chip.textContent = profile.user.displayName;
    chip.classList.remove('offline');
    chip.classList.add('online');
    const d = profile.developerAccount || {};
    document.getElementById('accountWhoami').textContent =
      'Signed in as ' +
      profile.user.displayName +
      ' (' + profile.user.email + ')' +
      ' · account: ' + (d.displayName || 'Unlinked');
    summary.replaceChildren();
    const pills = [
      'Email: ' + profile.user.email,
      'Organization: ' + (d.organization || '—'),
      'Account status: ' + (d.isActive === false ? 'inactive' : 'active'),
    ];
    pills.forEach(text => {
      const span = document.createElement('span');
      span.className = 'account-pill';
      span.textContent = text;
      summary.appendChild(span);
    });
    const intro = document.getElementById('keysWizardIntro');
    if (intro) intro.hidden = false;
    syncChromeUi();
  }

  function homeRenderKeysSnapshot(rows) {
    const mount = document.getElementById('homeKeysSnapshot');
    if (!mount) return;
    mount.replaceChildren();
    if (!Array.isArray(rows) || rows.length === 0) {
      const p = document.createElement('p');
      p.className = 'portal-hint';
      p.style.margin = '0';
      p.innerHTML = '<strong>No keys yet.</strong> Go to <strong>API keys</strong> to create your first key, copy it once, then use the header <code style="font-size:11px">x-api-key</code>.';
      mount.appendChild(p);
      return;
    }
    const table = document.createElement('table');
    table.className = 'keys-table';
    table.innerHTML =
      '<thead><tr><th>Label</th><th>Tier</th><th>Prefix</th><th>Usage</th><th>Status</th></tr></thead><tbody></tbody>';
    const body = table.querySelector('tbody');
    rows.forEach(row => {
      const tr = document.createElement('tr');
      const statusClass = row.isActive ? 'key-status-active' : 'key-status-inactive';
      tr.innerHTML =
        '<td>' + (row.label || '—') + '</td>' +
        '<td><span class="tier-badge tier-' + (row.tier || 'free') + '">' + (row.tier || 'free') + '</span></td>' +
        '<td><code style="font-size:11px;color:var(--muted)">' + (row.keyPrefix || '—') + '</code></td>' +
        '<td>' + Number(row.usageCount || 0).toLocaleString() + '</td>' +
        '<td><span class="key-status-badge ' + statusClass + '">' + (row.isActive ? 'active' : 'inactive') + '</span></td>';
      body.appendChild(tr);
    });
    mount.appendChild(table);
    const note = document.createElement('p');
    note.className = 'table-note';
    note.style.marginTop = '12px';
    note.innerHTML = 'Rotate or revoke flows will appear here when the API adds them. Issuance stays under <strong>API keys</strong>.';
    mount.appendChild(note);
  }

  async function accountFetchMe() {
    try {
      const r = await fetch('/api/auth/me', { credentials: 'include' });
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  }

  async function accountRefresh() {
    accountHideErr();
    accountHideInfo();
    const profile = await accountFetchMe();
    accountProfile = profile;
    accountRenderSignedIn(profile);
    if (!profile) {
      sandboxAccountKeys = [];
      sandboxUpdateAccountKeyButton();
      return;
    }
    try {
      const r = await fetch('/api/account/keys', { credentials: 'include' });
      const data = await portalReadResponseBody(r);
      if (!r.ok) {
        accountShowErr(portalApiMessage(data));
        return;
      }
      homeRenderKeysSnapshot(data);
      sandboxAccountKeys = Array.isArray(data) ? data : [];
      sandboxUpdateAccountKeyButton();
    } catch {
      accountShowErr('Could not load account keys. Check your connection and try again.');
      sandboxAccountKeys = [];
      sandboxUpdateAccountKeyButton();
    }
  }

  async function accountEnsureLoaded() {
    if (accountBooted) return;
    accountBooted = true;
    accountSetMode('signin');
    await accountRefresh();
  }

  async function accountRegister() {
    accountHideErr();
    accountHideInfo();
    const btn = document.getElementById('accountPrimaryBtn');
    const payload = {
      displayName: document.getElementById('accountDisplayName').value.trim(),
      organization: document.getElementById('accountOrganization').value.trim(),
      email: document.getElementById('accountEmail').value.trim(),
      password: document.getElementById('accountPassword').value,
    };
    btn.disabled = true;
    btn.textContent = 'Creating…';
    if (window.location.protocol === 'file:') {
      accountShowErr(portalAuthTransportHint());
      btn.disabled = false;
      btn.textContent = 'Create account';
      return;
    }
    try {
      const r = await fetch('/api/auth/register', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await portalReadResponseBody(r);
      if (!r.ok) {
        accountShowErr(portalApiMessage(data));
        return;
      }
      accountShowInfo('Account created. You are now signed in.');
      await accountRefresh();
      keysStatusLoaded = false;
      setActiveTab('home');
    } catch {
      accountShowErr(await portalBuildAuthFailureMessage('Network error while creating account.'));
    } finally {
      btn.disabled = false;
      btn.textContent = 'Create account';
    }
  }

  async function accountLogin() {
    accountHideErr();
    accountHideInfo();
    const btn = document.getElementById('accountPrimaryBtn');
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    if (window.location.protocol === 'file:') {
      accountShowErr(portalAuthTransportHint());
      btn.disabled = false;
      btn.textContent = 'Sign in';
      return;
    }
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: document.getElementById('accountEmail').value.trim(),
          password: document.getElementById('accountPassword').value,
        }),
      });
      const data = await portalReadResponseBody(r);
      if (!r.ok) {
        accountShowErr(portalApiMessage(data));
        return;
      }
      accountShowInfo('Signed in.');
      await accountRefresh();
      keysStatusLoaded = false;
      setActiveTab('home');
    } catch {
      accountShowErr(await portalBuildAuthFailureMessage('Network error while signing in.'));
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  }

  async function accountLogout() {
    accountHideErr();
    accountHideInfo();
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    accountProfile = null;
    accountRenderSignedIn(null);
    homeRenderKeysSnapshot([]);
    accountShowInfo('Signed out.');
    keysStatusLoaded = false;
    
    // Clear sandbox keys on logout
    sandboxAccountKeys = [];
    sandboxUpdateAccountKeyButton();
    
    const activeTab = document.querySelector('.portal-tab-trigger.active')?.dataset.tab || '';
    if (isConsoleProtected(activeTab)) {
      setActiveTab('reference');
    }
  }

  let usageLastDeveloperAccountId = '';
  let usageLastKeyPrefix = '';

  const USAGE_TIER_HINT = {
    free: 'Entry limits for experiments and small scripts.',
    standard: 'Higher limits for production traffic.',
    premium: 'Maximum throughput; premium-only routes where enabled.',
  };

  function usageRenderScopes(scopes) {
    const el = document.getElementById('usageScopeList');
    el.replaceChildren();
    const list = Array.isArray(scopes) ? scopes : [];
    if (list.length === 0) {
      const span = document.createElement('span');
      span.className = 'usage-scope-pill';
      span.style.opacity = '0.75';
      span.textContent = 'none';
      el.appendChild(span);
      return;
    }
    for (const raw of list) {
      const span = document.createElement('span');
      span.className = 'usage-scope-pill';
      span.textContent = String(raw);
      el.appendChild(span);
    }
  }

  function usageCopyKeyPrefix() {
    const p = usageLastKeyPrefix;
    if (!p) return;
    const btn = document.getElementById('usageCopyPrefixBtn');
    navigator.clipboard.writeText(p).then(() => {
      btn.textContent = 'Copied';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = 'Copy prefix';
        btn.classList.remove('copied');
      }, 1800);
    }).catch(() => {
      btn.textContent = 'Failed';
      setTimeout(() => { btn.textContent = 'Copy prefix'; }, 1800);
    });
  }

  function usageCopyDeveloperAccountId() {
    const id = usageLastDeveloperAccountId;
    if (!id) return;
    const btn = document.getElementById('usageCopyDevIdBtn');
    navigator.clipboard.writeText(id).then(() => {
      btn.textContent = 'Copied';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = 'Copy id';
        btn.classList.remove('copied');
      }, 2000);
    }).catch(() => {
      btn.textContent = 'Copy failed';
      setTimeout(() => { btn.textContent = 'Copy id'; }, 2000);
    });
  }

  // ── Load usage stats ─────────────────────────────────────────
  async function loadUsage() {
    const key = document.getElementById('keyInput').value.trim();
    const errEl = document.getElementById('usageError');
    const cardEl = document.getElementById('statsCard');
    const btn = document.getElementById('loadBtn');
    const successEl = document.getElementById('usageSuccess');
    const live = document.getElementById('usageLiveRegion');

    errEl.style.display = 'none';
    successEl.classList.remove('visible');
    successEl.textContent = '';
    live.textContent = '';
    cardEl.style.display = 'none';
    cardEl.classList.remove('visible-loaded');
    document.getElementById('usageChipsRow').classList.remove('visible');
    document.getElementById('usageDevInactiveBanner').classList.remove('visible');

    if (!key) {
      errEl.textContent = 'Paste your API key to load this dashboard.';
      errEl.style.display = 'block';
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Loading…';

    try {
      const r = await fetch('/api/usage', {
        headers: { 'x-api-key': key }
      });
      const data = await portalReadResponseBody(r);

      if (!r.ok) {
        errEl.textContent = portalApiMessage(data);
        errEl.style.display = 'block';
        return;
      }

      const label = typeof data.label === 'string' && data.label.trim() ? data.label.trim() : data.owner;
      document.getElementById('statsKeyLabel').textContent = label;
      const ownerLine = document.getElementById('statsOwnerLine');
      if (data.label && String(data.label).trim() && data.owner && String(data.owner).trim() !== String(data.label).trim()) {
        ownerLine.textContent = 'Owner on key record: ' + data.owner;
        ownerLine.style.display = '';
      } else {
        ownerLine.textContent = '';
        ownerLine.style.display = 'none';
      }

      const prefix = data.keyPrefix ? String(data.keyPrefix) : '';
      usageLastKeyPrefix = prefix;
      const prefixWrap = document.getElementById('usagePrefixWrap');
      if (prefix) {
        prefixWrap.style.display = '';
        document.getElementById('usagePrefixCode').textContent = prefix + '… (full secret never shown here)';
      } else {
        prefixWrap.style.display = 'none';
      }

      usageRenderScopes(data.scopes);
      document.getElementById('usageChipsRow').classList.add('visible');

      const expCol = document.getElementById('usageExpiresCol');
      const expNote = document.getElementById('usageExpiresNote');
      if (data.expiresAt) {
        const exp = new Date(data.expiresAt);
        const now = new Date();
        const ms = exp.getTime() - now.getTime();
        const days = Math.ceil(ms / 86400000);
        expCol.style.display = '';
        expNote.className = 'usage-expires-note' + (days > 30 ? ' calm' : '');
        if (days <= 0) {
          expNote.textContent =
            'Expired ' +
            exp.toLocaleDateString() +
            ' — the API may reject this key. Issue a replacement from API keys.';
        } else if (days <= 30) {
          expNote.textContent =
            'Expires ' + exp.toLocaleDateString() + ' · ' + days + ' day' + (days === 1 ? '' : 's') + ' remaining.';
        } else {
          expNote.textContent = 'Expires ' + exp.toLocaleDateString() + ' (' + days + ' days).';
        }
      } else {
        expCol.style.display = 'none';
        expNote.textContent = '';
      }

      const activeEl = document.getElementById('statsActive');
      activeEl.textContent = data.isActive ? 'Active' : 'Inactive';
      activeEl.className = 'stats-active' + (data.isActive ? '' : ' inactive');
      activeEl.setAttribute('aria-label', data.isActive ? 'Key status: active' : 'Key status: inactive');

      document.getElementById('statRequests').textContent = Number(data.usageCount || 0).toLocaleString();

      const tierEl = document.getElementById('statTier');
      const VALID_TIERS = ['free', 'standard', 'premium'];
      const safeTier = VALID_TIERS.includes(data.tier) ? data.tier : 'free';
      tierEl.innerHTML = '<span class="tier-badge tier-' + safeTier + '">' + safeTier + '</span>';
      document.getElementById('statTierSub').textContent = USAGE_TIER_HINT[safeTier] || '';

      document.getElementById('statLastUsed').textContent =
        data.lastUsed ? timeAgo(new Date(data.lastUsed)) : 'Never';
      document.getElementById('statLastUsedSub').textContent =
        data.lastUsed ? new Date(data.lastUsed).toLocaleString() : 'No traffic recorded yet';

      const created = data.createdAt ? new Date(data.createdAt) : null;
      document.getElementById('statSince').textContent = created
        ? created.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : '—';
      document.getElementById('statSinceSub').textContent = created
        ? created.toLocaleString()
        : '';

      const keyEmail = data.email ? String(data.email) : '';
      const synthetic = keyEmail.includes('@amethyst-api.local');
      document.getElementById('statEmail').textContent = synthetic
        ? 'Internal key email (synthetic id for our database — not your contact inbox).'
        : 'Key email on file: ' + keyEmail;

      const dev = data.developerAccount && typeof data.developerAccount === 'object' ? data.developerAccount : null;
      const devPanel = document.getElementById('usageDevAccount');
      const legPanel = document.getElementById('usageLegacyAccount');
      const inactiveBanner = document.getElementById('usageDevInactiveBanner');
      usageLastDeveloperAccountId = dev && dev.id ? String(dev.id) : '';
      if (dev && dev.displayName) {
        devPanel.classList.add('visible');
        legPanel.classList.remove('visible');
        document.getElementById('usageDevDisplayName').textContent = dev.displayName;
        inactiveBanner.classList.toggle('visible', dev.isActive === false);
        const orgRow = document.getElementById('usageDevOrgRow');
        if (dev.organization) {
          orgRow.style.display = '';
          document.getElementById('usageDevOrg').textContent = dev.organization;
        } else {
          orgRow.style.display = 'none';
        }
        const emRow = document.getElementById('usageDevEmailRow');
        if (dev.contactEmail) {
          emRow.style.display = '';
          document.getElementById('usageDevEmail').textContent = dev.contactEmail;
        } else {
          emRow.style.display = 'none';
        }
        document.getElementById('usageDevId').textContent = usageLastDeveloperAccountId;
      } else {
        devPanel.classList.remove('visible');
        legPanel.classList.add('visible');
        inactiveBanner.classList.remove('visible');
      }

      const refreshed = new Date().toLocaleString();
      successEl.textContent = 'Snapshot loaded at ' + refreshed + '.';
      successEl.classList.add('visible');
      live.textContent = 'Usage dashboard updated for ' + label + '.';

      cardEl.style.display = 'block';
      requestAnimationFrame(() => {
        cardEl.classList.add('visible-loaded');
      });
    } catch {
      errEl.textContent = 'Could not reach the server. Try again.';
      errEl.style.display = 'block';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Refresh';
    }
  }

  // Allow Enter key in input
  document.getElementById('keyInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') loadUsage();
  });

  // ── Sample draft — single-player valuation (fixtures) ─────────
  const SANDBOX_FIXTURE_FILES = [
    'pre_draft.json',
    'after_pick_10.json',
    'after_pick_50.json',
    'after_pick_100.json',
    'after_pick_130.json',
  ];
  let sandboxFixturePrimed = false;
  /** @type {Record<string, string>} */
  const sandboxFixtureRaw = {};
  let sandboxActiveFile = 'pre_draft.json';

  function sandboxHideErr() {
    const el = document.getElementById('sandboxError');
    el.style.display = 'none';
    el.textContent = '';
  }

  function sandboxShowErr(msg) {
    const el = document.getElementById('sandboxError');
    el.textContent = msg;
    el.style.display = 'block';
  }

  function sandboxPrettyJson(raw) {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }

  function sandboxUpdateMeta() {
    const raw = sandboxFixtureRaw[sandboxActiveFile];
    const meta = document.getElementById('sandboxContextMeta');
    if (!raw) {
      meta.textContent = 'Fixture missing or failed to load for ' + sandboxActiveFile + '.';
      return;
    }
    let checkpoint = '';
    try {
      checkpoint = JSON.parse(raw).checkpoint || '';
    } catch (_) { /* ignore */ }
    meta.textContent =
      'Showing ' +
      sandboxActiveFile +
      (checkpoint ? ' (checkpoint: ' + checkpoint + ')' : '') +
      '.';
  }

  function sandboxRenderContextPre() {
    const raw = sandboxFixtureRaw[sandboxActiveFile];
    const pre = document.getElementById('sandboxContextPre');
    if (!raw) {
      pre.textContent = '(Could not load ' + sandboxActiveFile + ' — run pnpm run convert-2026-draft.)';
    } else {
      pre.textContent = sandboxPrettyJson(raw);
    }
    sandboxUpdateMeta();
  }

  function sandboxSetActiveFile(file) {
    sandboxActiveFile = file;
    document.querySelectorAll('.sandbox-case-tab').forEach(btn => {
      const on = btn.dataset.sandboxFile === file;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    sandboxRenderContextPre();
  }

  document.querySelector('.sandbox-case-tabs')?.addEventListener('click', ev => {
    const btn = ev.target.closest('.sandbox-case-tab');
    if (!btn || !btn.dataset.sandboxFile) return;
    sandboxSetActiveFile(btn.dataset.sandboxFile);
  });

  async function sandboxEnsureLoaded() {
    if (sandboxFixturePrimed) return;
    sandboxFixturePrimed = true;
    const pre = document.getElementById('sandboxContextPre');
    const out = document.getElementById('sandboxOut');
    pre.textContent = 'Loading checkpoint files…';
    out.textContent = 'Loading…';
    let failed = false;
    for (const name of SANDBOX_FIXTURE_FILES) {
      try {
        const r = await fetch('/fixtures/checkpoints/' + encodeURIComponent(name));
        if (!r.ok) {
          failed = true;
          sandboxFixtureRaw[name] = '';
          continue;
        }
        sandboxFixtureRaw[name] = await r.text();
      } catch {
        failed = true;
        sandboxFixtureRaw[name] = '';
      }
    }
    if (failed) {
      sandboxShowErr(
        'One or more fixtures failed to load. On this repo run: pnpm run convert-2026-draft /path/to/2026Draft.xlsx'
      );
    }
    sandboxSetActiveFile('pre_draft.json');
    out.textContent = 'Choose a checkpoint, enter player_id and x-api-key, then run.';
  }

  function sandboxCopyActiveFixture() {
    const raw = sandboxFixtureRaw[sandboxActiveFile];
    if (!raw) return;
    const btn = document.getElementById('sandboxCopyContextBtn');
    const defaultTitle = 'Copy league context JSON';
    const defaultLabel = 'Copy league context JSON';
    function resetCopyUi() {
      btn.classList.remove('copied', 'copy-fail');
      btn.title = defaultTitle;
      btn.setAttribute('aria-label', defaultLabel);
      if (btn._sandboxCopyTimer) {
        clearTimeout(btn._sandboxCopyTimer);
        btn._sandboxCopyTimer = null;
      }
    }
    resetCopyUi();
    navigator.clipboard.writeText(raw).then(() => {
      btn.classList.add('copied');
      btn.title = 'Copied to clipboard';
      btn.setAttribute('aria-label', 'Copied to clipboard');
      btn._sandboxCopyTimer = setTimeout(resetCopyUi, 2000);
    }).catch(() => {
      btn.classList.add('copy-fail');
      btn.title = 'Could not copy — check permissions';
      btn.setAttribute('aria-label', 'Copy failed');
      btn._sandboxCopyTimer = setTimeout(resetCopyUi, 2200);
    });
  }

  function sandboxCopyKeyFromUsage() {
    const u = document.getElementById('keyInput');
    const s = document.getElementById('sandboxApiKey');
    if (u && u.value.trim()) s.value = u.value.trim();
  }

  let sandboxAccountKeys = [];

  function sandboxUpdateAccountKeyButton() {
    const btn = document.getElementById('sandboxUseAccountKeyBtn');
    if (!btn) return;
    
    if (sandboxAccountKeys.length > 0 && accountProfile && accountProfile.developerAccount) {
      btn.style.display = 'block';
      btn.textContent = 'Use account key';
    } else {
      btn.style.display = 'none';
    }
  }

  function sandboxUseAccountKey() {
    if (sandboxAccountKeys.length === 0) {
      sandboxShowErr('No keys found in your account. Go to API keys to create one.');
      return;
    }
    const key = sandboxAccountKeys[0].fullKey || '';
    if (!key) {
      sandboxShowErr('Key secret not available. You may need to create a new key.');
      return;
    }
    document.getElementById('sandboxApiKey').value = key;
    sandboxHideErr();
  }

  async function sandboxRunPlayerValuation() {
    sandboxHideErr();
    const key = document.getElementById('sandboxApiKey').value.trim();
    const pid = document.getElementById('sandboxPlayerId').value.trim();
    const out = document.getElementById('sandboxOut');
    const btn = document.getElementById('sandboxRunBtn');
    const raw = sandboxFixtureRaw[sandboxActiveFile];

    if (!key) {
      sandboxShowErr('Paste an x-api-key (or click “Use key from Usage”).');
      return;
    }
    if (!pid) {
      sandboxShowErr('Enter a player_id to value.');
      return;
    }
    if (!raw) {
      sandboxShowErr('Fixture not loaded. Reload this tab or run the convert script to publish files under /public/fixtures/checkpoints/.');
      return;
    }
    let base;
    try {
      base = JSON.parse(raw);
    } catch {
      sandboxShowErr('Stored fixture is not valid JSON.');
      return;
    }

    const body = { ...base, player_id: pid };

    btn.disabled = true;
    btn.textContent = 'Posting…';
    out.textContent = '';
    try {
      const r = await fetch('/valuation/player', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
        },
        body: JSON.stringify(body),
      });
      const text = await r.text();
      let pretty = text;
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2);
      } catch (_) { /* keep raw */ }
      out.textContent = 'HTTP ' + r.status + '\n\n' + pretty;
      if (!r.ok) {
        sandboxShowErr('Request finished with HTTP ' + r.status + ' (see response below).');
      }
    } catch {
      sandboxShowErr('Could not reach the server.');
      out.textContent = '';
    } finally {
      btn.disabled = false;
      btn.textContent = 'POST /valuation/player';
    }
  }

  document.getElementById('sandboxPlayerId')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') sandboxRunPlayerValuation();
  });

  // ── API key issuance (Get a key tab) ───────────────────────────
  let keysStatusLoaded = false;
  let keysRequiresToken = false;
  let keysIssuedValue = '';
  /** Mongo id string from POST /api/developers — sent with POST /api/keys/issue */
  let keysDeveloperAccountId = null;
  let keysLastAccountDisplayName = '';

  function keysHide(el) { el.style.display = 'none'; }
  function keysShow(el) { el.style.display = 'block'; }

  async function keysEnsureStatus() {
    if (keysStatusLoaded) return;
    await accountEnsureLoaded();
    const loading = document.getElementById('keysLoading');
    const errBanner = document.getElementById('keysErrorBanner');
    const infoBanner = document.getElementById('keysInfoBanner');
    const disabledPanel = document.getElementById('keysDisabledPanel');
    const wizardPanel = document.getElementById('keysWizardPanel');

    keysShow(loading);
    keysHide(errBanner);
    keysHide(infoBanner);
    disabledPanel.classList.remove('visible');
    wizardPanel.classList.remove('visible');

    try {
      const r = await fetch('/api/keys/status');
      const data = await portalReadResponseBody(r);
      keysHide(loading);
      keysStatusLoaded = true;

      if (!accountProfile || !accountProfile.developerAccount) {
        const accErr = document.getElementById('accountError');
        const haveAccErr =
          accErr && accErr.style.display === 'block' && String(accErr.textContent || '').trim();
        if (!haveAccErr) {
          keysShow(errBanner);
          errBanner.textContent =
            'Sign in above and complete registration to link a developer account before issuing keys.';
        }
        return;
      }

      if (!data.issuanceEnabled) {
        disabledPanel.classList.add('visible');
        return;
      }

      wizardPanel.classList.add('visible');
      keysRequiresToken = Boolean(data.requiresToken);
      keysDeveloperAccountId = accountProfile.developerAccount.id || null;
      keysLastAccountDisplayName = accountProfile.developerAccount.displayName || '';
      const accountNameEl = document.getElementById('keysAccountName');
      const emailEl = document.getElementById('keysEmail');
      const orgEl = document.getElementById('keysOrganization');
      accountNameEl.value = keysLastAccountDisplayName;
      emailEl.value = accountProfile.user?.email || '';
      if (accountProfile.developerAccount.organization) {
        orgEl.value = accountProfile.developerAccount.organization;
      }
      accountNameEl.readOnly = true;
      emailEl.readOnly = true;
      orgEl.readOnly = true;
      keysShow(infoBanner);
      infoBanner.textContent =
        'Signed in as ' +
        (accountProfile.user?.email || 'account user') +
        '. Identity fields are read-only in this form.';
      const tokenWrap = document.getElementById('keysIssuanceTokenWrap');
      if (keysRequiresToken) {
        keysShow(tokenWrap);
      } else {
        keysHide(tokenWrap);
      }
    } catch {
      keysHide(loading);
      const accErr = document.getElementById('accountError');
      const haveAccErr =
        accErr && accErr.style.display === 'block' && String(accErr.textContent || '').trim();
      if (!haveAccErr) {
        keysShow(errBanner);
        errBanner.textContent = 'Could not reach the server to check key issuance.';
      }
    }
  }

  function keysSetStepIndicator(step) {
    const tier = document.querySelector('input[name="keysTier"]:checked')?.value || 'free';
    document.querySelectorAll('[data-step-indicator]').forEach(pill => {
      const n = +pill.dataset.stepIndicator;
      pill.classList.remove('active', 'done', 'skipped');
      if (n < step) pill.classList.add('done');
      if (n === step) pill.classList.add('active');
    });
    const pill2 = document.querySelector('[data-step-indicator="2"]');
    if (pill2 && step >= 3 && tier === 'free') {
      pill2.classList.remove('active', 'done');
      pill2.classList.add('skipped');
    }
  }

  function keysGoStepFromKeyBack() {
    const tier = document.querySelector('input[name="keysTier"]:checked')?.value || 'free';
    if (tier === 'free') keysGoStep(1);
    else keysGoStep(2);
  }

  function keysGoStep(step) {
    const errBanner = document.getElementById('keysErrorBanner');
    keysHide(errBanner);

    if (step === 1) {
      keysDeveloperAccountId = null;
      keysLastAccountDisplayName = '';
      const linkPrev = document.getElementById('keysLinkedAccountPreview');
      if (linkPrev) linkPrev.textContent = '';
    }

    if (step === 2) {
      const owner = document.getElementById('keysOwner').value.trim();
      if (!owner) {
        keysShow(errBanner);
        errBanner.textContent = 'Enter an API key label before continuing.';
        return;
      }
      const tier = document.querySelector('input[name="keysTier"]:checked')?.value || 'free';
      document.getElementById('keysBillingPlanPreview').value =
        tier.charAt(0).toUpperCase() + tier.slice(1) + ' tier — demo checkout';
      document.getElementById('keysBillingAck').checked = false;
      document.getElementById('keysStep2Next').disabled = true;
      const linkPrev = document.getElementById('keysLinkedAccountPreview');
      if (linkPrev && keysDeveloperAccountId && keysLastAccountDisplayName) {
        linkPrev.textContent =
          'Developer account linked: “' +
          keysLastAccountDisplayName +
          '”. This key will be stored under that account for usage and support.';
      }
    }

    if (step === 3) {
      const tier = document.querySelector('input[name="keysTier"]:checked')?.value || 'free';
      if (tier !== 'free' && !document.getElementById('keysBillingAck').checked) {
        keysShow(errBanner);
        errBanner.textContent = 'Confirm the course billing simulation checkbox to continue.';
        return;
      }
    }

    keysHide(document.getElementById('keysStep1'));
    keysHide(document.getElementById('keysStep2'));
    keysHide(document.getElementById('keysStep3'));

    if (step === 1) keysShow(document.getElementById('keysStep1'));
    if (step === 2) keysShow(document.getElementById('keysStep2'));
    if (step === 3) keysShow(document.getElementById('keysStep3'));

    keysSetStepIndicator(step);
  }

  async function keysOnContinueFromStep1() {
    const errBanner = document.getElementById('keysErrorBanner');
    keysHide(errBanner);
    const btn = document.getElementById('keysStep1ContinueBtn');
    if (!accountProfile || !accountProfile.developerAccount) {
      keysShow(errBanner);
      errBanner.textContent = 'Sign in above and ensure your account has a linked developer profile.';
      return;
    }
    const accountName = document.getElementById('keysAccountName').value.trim();
    if (!accountName) {
      keysShow(errBanner);
      errBanner.textContent = 'Enter a developer account name (your team or product).';
      return;
    }
    let owner = document.getElementById('keysOwner').value.trim();
    if (!owner) {
      owner = accountName + ' — API key';
      document.getElementById('keysOwner').value = owner;
    }
    const email = accountProfile.user?.email || document.getElementById('keysEmail').value.trim();
    const org = accountProfile.developerAccount?.organization || document.getElementById('keysOrganization').value.trim();
    const tier = document.querySelector('input[name="keysTier"]:checked')?.value || 'free';
    btn.disabled = true;
    btn.textContent = 'Confirming account…';
    try {
      keysDeveloperAccountId = accountProfile.developerAccount.id;
      keysLastAccountDisplayName = accountProfile.developerAccount.displayName || accountName;
      if (email) document.getElementById('keysEmail').value = email;
      if (org) document.getElementById('keysOrganization').value = org;
      if (tier === 'free') keysGoStep(3);
      else keysGoStep(2);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Continue';
    }
  }

  document.getElementById('keysBillingAck').addEventListener('change', e => {
    document.getElementById('keysStep2Next').disabled = !e.target.checked;
  });

  document.getElementById('keysCopiedAck').addEventListener('change', e => {
    const done = document.getElementById('keysDoneBtn');
    done.disabled = !e.target.checked;
    done.style.opacity = e.target.checked ? '1' : '0.5';
  });

  async function keysIssue() {
    const errBanner = document.getElementById('keysErrorBanner');
    keysHide(errBanner);

    const tokenInput = document.getElementById('keysIssuanceToken');
    if (keysRequiresToken && !tokenInput.value.trim()) {
      keysShow(errBanner);
      errBanner.textContent = 'Enter issuance token provided by your operator.';
      return;
    }

    const owner = document.getElementById('keysOwner').value.trim();
    const tier = document.querySelector('input[name="keysTier"]:checked')?.value || 'free';
    const btn = document.getElementById('keysGenerateBtn');
    btn.disabled = true;
    btn.textContent = 'Creating…';

    const headers = { 'Content-Type': 'application/json' };
    if (keysRequiresToken) headers['X-Key-Issuance-Token'] = tokenInput.value.trim();

    try {
      const issueBody = {
        label: owner,
        tier,
      };
      const r = await fetch('/api/account/keys/issue', {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify(issueBody),
      });
      const data = await portalReadResponseBody(r);

      if (!r.ok) {
        keysShow(errBanner);
        errBanner.textContent = portalApiMessage(data);
        return;
      }

      keysIssuedValue = data.apiKey || '';
      document.getElementById('keysRevealPre').textContent = keysIssuedValue;
      const devEcho = document.getElementById('keysDeveloperIdEcho');
      if (devEcho) {
        const did = data.developerAccountId ?? keysDeveloperAccountId;
        devEcho.textContent = did != null && String(did).length > 0
          ? 'Developer account id (for support / automation): ' + String(did)
          : '';
      }
      keysHide(document.getElementById('keysGenerateRow'));
      keysShow(document.getElementById('keysRevealBlock'));
      document.getElementById('keysCopiedAck').checked = false;
      document.getElementById('keysDoneBtn').disabled = true;
      document.getElementById('keysDoneBtn').style.opacity = '0.5';
      keysSetStepIndicator(3);
      
      // Store the full key for playground use
      if (keysIssuedValue) {
        const newKey = {
          label: owner,
          tier: tier,
          fullKey: keysIssuedValue,
          isActive: true,
        };
        sandboxAccountKeys.unshift(newKey);
        sandboxUpdateAccountKeyButton();
      }
    } catch {
      keysShow(errBanner);
      errBanner.textContent = 'Network error while creating key.';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Generate API key';
    }
  }

  function keysCopyKey() {
    const btn = document.getElementById('keysCopyBtn');
    if (!keysIssuedValue) return;
    navigator.clipboard.writeText(keysIssuedValue).then(() => {
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = 'Copy';
        btn.classList.remove('copied');
      }, 2000);
    });
  }

  function keysFinish() {
    keysIssuedValue = '';
    document.getElementById('keysRevealPre').textContent = '';
    const devEcho = document.getElementById('keysDeveloperIdEcho');
    if (devEcho) devEcho.textContent = '';
    keysHide(document.getElementById('keysRevealBlock'));
    keysShow(document.getElementById('keysGenerateRow'));
    const accountNameEl = document.getElementById('keysAccountName');
    const orgEl = document.getElementById('keysOrganization');
    const emailEl = document.getElementById('keysEmail');
    accountNameEl.readOnly = false;
    orgEl.readOnly = false;
    emailEl.readOnly = false;
    accountNameEl.value = accountProfile?.developerAccount?.displayName || '';
    orgEl.value = accountProfile?.developerAccount?.organization || '';
    document.getElementById('keysOwner').value = '';
    emailEl.value = accountProfile?.user?.email || '';
    document.getElementById('keysIssuanceToken').value = '';
    document.querySelector('#tierFree').checked = true;
    keysDeveloperAccountId = null;
    keysLastAccountDisplayName = '';
    keysGoStep(1);
    const info = document.getElementById('keysInfoBanner');
    keysShow(info);
    info.textContent = 'Wizard reset. You can issue another key when needed.';
    setTimeout(() => keysHide(info), 5000);
    
    // Clear sandbox keys when finishing wizard
    sandboxAccountKeys = [];
    sandboxUpdateAccountKeyButton();
  }

  // ── Relative time helper ──────────────────────────────────────
  function timeAgo(date) {
    const sec = Math.floor((Date.now() - date) / 1000);
    if (sec < 60) return 'just now';
    if (sec < 3600) return Math.floor(sec / 60) + ' minutes ago';
    if (sec < 86400) return Math.floor(sec / 3600) + ' hours ago';
    return Math.floor(sec / 86400) + ' days ago';
  }

  (async function portalApplySessionAndHash() {
    try {
      accountSetMode('signin');
      await accountRefresh();
      accountBooted = true;
    } catch (_) {}
    let h = (window.location.hash || '').replace(/^#/, '');
    if (h === 'organization') {
      h = 'keys';
      try {
        if (window.history && window.history.replaceState) window.history.replaceState(null, '', '#keys');
      } catch (_) { /* ignore */ }
    }
    if (h && document.getElementById('tab-' + h)) {
      setActiveTab(h, { skipHash: true });
    } else if (accountProfile && !h) {
      setActiveTab('home', { skipHash: true });
    } else {
      const active = document.querySelector('.portal-tab-trigger.active');
      document.body.dataset.portalTab = active && active.dataset.tab ? active.dataset.tab : 'reference';
    }
  })();
