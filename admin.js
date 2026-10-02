const api = (path, options = {}) => fetch(path, { ...options, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionStorage.getItem('orbitAdminToken') || ''}`, ...(options.headers || {}) } }).then(async (response) => { const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Request failed.'); return data; });
const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
const statusBadge = (status) => `<span class="status ${String(status).toLowerCase().replace(/[^a-z0-9]+/g, '-')}">${escapeHtml(status)}</span>`;
const setError = (message) => { $('adminError').textContent = message; };
let adjustmentContext = null;
const formatDate = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value || '') : date.toLocaleString();
};

const renderTransactions = (items, target, withActions = false) => {
  $(target).innerHTML = items.map((transaction) => `<tr><td>${escapeHtml(transaction.id)}</td><td>${escapeHtml(transaction.user)}</td><td>${escapeHtml(transaction.pair)}</td><td>${escapeHtml(transaction.amount)}</td><td>${statusBadge(transaction.status)}</td><td>${withActions ? `<select class="status-select" data-id="${escapeHtml(transaction.id)}"><option ${transaction.status === 'Pending' ? 'selected' : ''}>Pending</option><option ${transaction.status === 'Success' ? 'selected' : ''}>Success</option><option ${transaction.status === 'Rejected' ? 'selected' : ''}>Rejected</option></select>` : escapeHtml(transaction.date)}</td></tr>`).join('');
};
const userActionMarkup = (user) => {
  if (user.role !== 'User') return '—';
  const id = escapeHtml(user.id);
  const actions = [];
  if (user.status === 'Pending') actions.push(`<button class="row-action approve" data-user-action="approve" data-id="${id}">Approve</button>`);
  if (user.status === 'Active') {
    actions.push(`<button class="row-action add" data-user-action="add" data-id="${id}">Add funds</button>`);
    actions.push(`<button class="row-action" data-user-action="withdraw" data-id="${id}">Withdraw</button>`);
    actions.push(`<button class="row-action" data-user-action="suspend" data-id="${id}">Suspend</button>`);
  }
  if (user.status === 'Suspended') {
    actions.push(`<button class="row-action approve" data-user-action="activate" data-id="${id}">Activate</button>`);
    actions.push(`<button class="row-action add" data-user-action="add" data-id="${id}">Add funds</button>`);
    actions.push(`<button class="row-action" data-user-action="withdraw" data-id="${id}">Withdraw</button>`);
  }
  if (user.status === 'Deleted') actions.push(`<button class="row-action approve" data-user-action="restore" data-id="${id}">Restore</button>`);
  if (user.status !== 'Deleted') actions.push(`<button class="row-action delete" data-user-action="delete" data-id="${id}">Delete</button>`);
  return `<div class="user-actions">${actions.join('')}</div>`;
};
const loadUsers = async () => {
  const users = await api('/api/admin/users');
  const query = $('userSearch').value.toLowerCase();
  $('usersTable').innerHTML = users.filter((user) => `${user.name} ${user.email}`.toLowerCase().includes(query)).map((user) => {
    const balances = Object.entries(user.internalBalances || {}).map(([asset, amount]) => `${escapeHtml(asset)} ${escapeHtml(amount)}`).join(' · ') || '—';
    return `<tr><td>${escapeHtml(user.name)}</td><td>${escapeHtml(user.email)}</td><td>${escapeHtml(user.role)}</td><td>${statusBadge(user.status)}</td><td>${escapeHtml(user.joined)}</td><td>${balances}</td><td>${userActionMarkup(user)}</td></tr>`;
  }).join('');
};
const loadRequests = async () => {
  const requests = await api('/api/admin/requests');
  $('requestsTable').innerHTML = requests.map((item) => {
    const details = item.type === 'deposit'
      ? `<code>${escapeHtml(item.txHash || '')}</code>`
      : `<span>${escapeHtml(item.recipient || '')}</span>`;
    const payoutStatus = item.type === 'withdrawal' && item.status === 'Approved' ? (item.payoutStatus || 'Awaiting payout') : '';
    const payoutUpdatedAt = Date.parse(item.payoutUpdatedAt || '');
    const retryStalePayout = payoutStatus === 'Processing' && (!Number.isFinite(payoutUpdatedAt) || Date.now() - payoutUpdatedAt >= 60000);
    const status = `${statusBadge(item.status)}${payoutStatus ? `<br>${statusBadge(payoutStatus)}` : ''}`;
    const payoutDetails = item.payoutReference
      ? `<br><small>Transaction reference: <code>${escapeHtml(item.payoutReference)}</code></small>`
      : item.payoutError
        ? `<br><small class="payout-error">${escapeHtml(item.payoutError)}</small>`
        : '';
    const actions = item.status === 'Pending'
      ? `<div class="review-actions"><button class="row-action approve" data-request-review="approve" data-id="${escapeHtml(item.id)}">Approve</button><button class="row-action reject" data-request-review="reject" data-id="${escapeHtml(item.id)}">Reject</button></div>`
      : payoutStatus === 'Awaiting payout' || payoutStatus === 'Failed'
        ? `<button class="row-action approve" data-settle-request data-id="${escapeHtml(item.id)}">${payoutStatus === 'Failed' ? 'Retry payout' : 'Send payout'}</button>`
      : payoutStatus === 'Processing' && retryStalePayout
        ? `<button class="row-action approve" data-settle-request data-id="${escapeHtml(item.id)}">Retry payout</button>`
        : payoutStatus === 'Processing' ? '<small>Payout processing…</small>' : '—';
    return `<tr><td>${escapeHtml(formatDate(item.createdAt))}</td><td>${escapeHtml(item.user)}<br><small>${escapeHtml(item.email)}</small></td><td>${item.type === 'deposit' ? 'Deposit claim' : 'Withdrawal request'}</td><td>${escapeHtml(item.asset)} / ${escapeHtml(item.network)}</td><td>${escapeHtml(item.amount)} ${escapeHtml(item.asset)}</td><td class="details-cell">${details}${payoutDetails}</td><td>${status}</td><td>${actions}</td></tr>`;
  }).join('');
};

let custodyReadinessRequest = null;
const renderCustodyReadiness = (readiness) => {
  const configuration = {
    not_configured: 'Not configured',
    invalid_configuration: 'Invalid configuration',
    verification_failed: 'Configured',
    verified: 'Configured',
  };
  const verification = {
    not_configured: 'Not checked',
    invalid_configuration: 'Not checked',
    verification_failed: 'Could not verify',
    verified: 'Verified',
  };
  const message = {
    not_configured: 'Set the custody API URL and token to make provider verification available.',
    invalid_configuration: 'The custody API configuration is invalid. Check its settings without sharing the token.',
    verification_failed: 'The custody provider could not be verified. Customer receiving remains subject to its own live verification.',
    verified: 'The custody provider passed its latest health verification. Customer receiving still requires its own live verification.',
  };
  $('custodyConfigurationStatus').textContent = configuration[readiness.status] || 'Unknown';
  $('custodyVerificationStatus').textContent = verification[readiness.status] || 'Unknown';
  $('custodyReadinessMessage').textContent = message[readiness.status] || 'The readiness result is unavailable.';
  $('custodyReadinessChecked').textContent = readiness.checkedAt ? `Checked ${formatDate(readiness.checkedAt)}` : '';
  $('custodyVerificationStatus').classList.toggle('readiness-verified', readiness.status === 'verified');
  $('custodyVerificationStatus').classList.toggle('readiness-failed', readiness.status !== 'verified');
};
const loadCustodyReadiness = () => {
  if (custodyReadinessRequest) return custodyReadinessRequest;
  $('refreshCustodyReadiness').disabled = true;
  $('custodyVerificationStatus').textContent = 'Checking…';
  $('custodyReadinessMessage').textContent = 'Checking the custody provider…';
  custodyReadinessRequest = (async () => {
    try {
      renderCustodyReadiness(await api('/api/admin/custody-readiness'));
    } catch {
      renderCustodyReadiness({ status: 'check_unavailable' });
    } finally {
      $('refreshCustodyReadiness').disabled = false;
      custodyReadinessRequest = null;
    }
  })();
  return custodyReadinessRequest;
};

const loadOverview = async () => {
  const data = await api('/api/admin/overview');
  $('metricUsers').textContent = data.metrics.users;
  $('metricActive').textContent = data.metrics.activeUsers;
  $('metricVolume').textContent = data.metrics.volume;
  $('metricPending').textContent = data.metrics.pending;
  renderTransactions(data.transactions, 'recentTransactions');
  $('maintenanceToggle').checked = data.settings.maintenance;
  $('defaultNetwork').value = data.settings.defaultNetwork;
  $('supportEmail').value = data.settings.supportEmail;
  void loadCustodyReadiness();
};
const loadTransactions = async () => renderTransactions(await api('/api/admin/transactions'), 'transactionsTable', true);
const showView = async (view) => {
  document.querySelectorAll('.admin-view').forEach((section) => section.classList.add('hidden'));
  $(`${view}View`).classList.remove('hidden');
  document.querySelectorAll('.side-link').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  $('viewTitle').textContent = view[0].toUpperCase() + view.slice(1);
  try { if (view === 'overview') await loadOverview(); if (view === 'users') await loadUsers(); if (view === 'requests') await loadRequests(); if (view === 'transactions') await loadTransactions(); } catch (error) { setError(error.message); }
};

$('adminLoginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('loginError').textContent = '';
  try {
    const data = await fetch('/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: $('adminEmail').value, password: $('adminPassword').value }) }).then(async (response) => { const result = await response.json(); if (!response.ok) throw new Error(result.error); return result; });
    sessionStorage.setItem('orbitAdminToken', data.token);
    $('adminLogin').classList.add('hidden');
    $('adminDashboard').classList.remove('hidden');
    await showView('overview');
  } catch (error) { $('loginError').textContent = error.message; }
});
document.querySelectorAll('.side-link, [data-view-target]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view || button.dataset.viewTarget)));
$('userSearch').addEventListener('input', loadUsers);
$('usersTable').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-user-action]');
  if (!button) return;
  const id = button.dataset.id;
  const action = button.dataset.userAction;
  try {
    if (action === 'add' || action === 'withdraw') {
      const users = await api('/api/admin/users');
      const user = users.find((item) => item.id === id);
      if (!user) throw new Error('User not found.');
      adjustmentContext = { id, operation: action };
      $('adjustmentTitle').textContent = action === 'add' ? 'Add funds' : 'Withdraw funds';
      $('adjustmentUser').textContent = `${user.name} · ${user.email}`;
      $('adjustmentError').textContent = '';
      $('adjustmentForm').reset();
      $('adjustmentDialog').showModal();
      return;
    }
    if (action === 'approve') {
      if (!window.confirm('Approve this verified-email registration and let the user sign in?')) return;
      await api(`/api/admin/users/${encodeURIComponent(id)}/approve`, { method: 'POST' });
    } else if (action === 'suspend' || action === 'activate') {
      const status = action === 'suspend' ? 'Suspended' : 'Active';
      if (!window.confirm(`${action === 'suspend' ? 'Suspend' : 'Reactivate'} this user account?`)) return;
      await api(`/api/admin/users/${encodeURIComponent(id)}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
    } else if (action === 'delete') {
      if (!window.confirm('Deactivate this account? Its request and financial history will be retained, and an admin can restore it later.')) return;
      await api(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } else if (action === 'restore') {
      if (!window.confirm('Restore this account to its previous status?')) return;
      await api(`/api/admin/users/${encodeURIComponent(id)}/restore`, { method: 'POST' });
    }
    await loadUsers();
  } catch (error) { setError(error.message); }
});
$('requestsTable').addEventListener('click', async (event) => {
  const settleButton = event.target.closest('button[data-settle-request]');
  const button = settleButton || event.target.closest('button[data-request-review]');
  if (!button) return;
  if (settleButton) {
    try {
      const request = (await api('/api/admin/requests')).find((item) => item.id === button.dataset.id);
      if (!request) throw new Error('Request not found.');
      const confirmation = [
        'Send this approved withdrawal through the verified payout provider?',
        '',
        `Asset: ${request.asset}`,
        `Network: ${request.network}`,
        `Amount: ${request.amount} ${request.asset}`,
        `Destination: ${request.recipient}`,
        '',
        'The provider must confirm the transfer and return a transaction reference before it is marked complete. Retrying uses the same provider request ID.',
      ].join('\n');
      if (!window.confirm(confirmation)) return;
      button.disabled = true;
      setError('');
      try {
        await api(`/api/admin/requests/${encodeURIComponent(request.id)}/settle`, { method: 'POST' });
        await loadRequests();
      } catch (error) {
        setError(error.message);
        await loadRequests();
      }
    } catch (error) { setError(error.message); }
    return;
  }
  const decision = button.dataset.requestReview;
  const request = (await api('/api/admin/requests')).find((item) => item.id === button.dataset.id);
  if (!request) { setError('Request not found.'); return; }
  const confirmation = request.type === 'deposit'
    ? 'Approve this claim only after manually checking its transaction hash. Approval adds an internal-ledger credit; it does not change custody funds.'
    : 'Approve this request to debit the internal ledger? No blockchain transfer will be initiated.';
  if (decision === 'approve' && !window.confirm(confirmation)) return;
  if (decision === 'reject' && !window.confirm('Reject this request? No funds will be credited or debited.')) return;
  try {
    await api(`/api/admin/requests/${encodeURIComponent(request.id)}/review`, { method: 'POST', body: JSON.stringify({ decision }) });
    await loadRequests();
  } catch (error) { setError(error.message); }
});
$('adjustmentForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!adjustmentContext) return;
  const saveButton = $('saveAdjustment');
  saveButton.disabled = true;
  $('adjustmentError').textContent = '';
  try {
    await api(`/api/admin/users/${encodeURIComponent(adjustmentContext.id)}/adjustments`, {
      method: 'POST',
      body: JSON.stringify({ operation: adjustmentContext.operation, asset: $('adjustmentAsset').value, amount: $('adjustmentAmount').value, note: $('adjustmentNote').value }),
    });
    $('adjustmentDialog').close();
    adjustmentContext = null;
    await loadUsers();
  } catch (error) { $('adjustmentError').textContent = error.message; }
  finally { saveButton.disabled = false; }
});
$('cancelAdjustment').addEventListener('click', () => { $('adjustmentDialog').close(); adjustmentContext = null; });
$('transactionsTable').addEventListener('change', async (event) => { if (!event.target.matches('.status-select')) return; try { await api(`/api/admin/transactions/${event.target.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ status: event.target.value }) }); await showView('transactions'); } catch (error) { setError(error.message); } });
$('refreshCustodyReadiness').addEventListener('click', () => { void loadCustodyReadiness(); });
$('saveSettings').addEventListener('click', async () => { try { await api('/api/admin/settings', { method: 'PATCH', body: JSON.stringify({ maintenance: $('maintenanceToggle').checked, defaultNetwork: $('defaultNetwork').value, supportEmail: $('supportEmail').value }) }); $('saveMessage').textContent = 'Settings saved'; setTimeout(() => { $('saveMessage').textContent = ''; }, 1800); } catch (error) { setError(error.message); } });
$('signOut').addEventListener('click', () => { sessionStorage.removeItem('orbitAdminToken'); location.reload(); });
