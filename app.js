const API_BASE_URL = window.location.protocol === 'file:' ? '' : window.location.origin;
let publicConfig;
let currentUser;
let walletMode = 'demo';
let googleScriptPromise;
let googleIdentityInitialized = false;
const $ = (id) => document.getElementById(id);
if ('serviceWorker' in navigator && window.location.protocol === 'http:') navigator.serviceWorker.register('/sw.js').catch(() => {});
const coinData = {
  BTC: { name: 'Bitcoin', logo: '₿', network: 'Bitcoin' }, ETH: { name: 'Ethereum', logo: '◆', network: 'Ethereum Mainnet' }, BNB: { name: 'BNB', logo: '◇', network: 'BEP 20' }, USDC: { name: 'USD Coin', logo: '$', network: 'ERC 20' }, USDT: { name: 'Tether', logo: '₮', network: 'ERC 20' }, XRP: { name: 'XRP', logo: '✕', network: 'XRP Ledger' }, SOL: { name: 'Solana', logo: '≋', network: 'Solana' }, ADA: { name: 'Cardano', logo: 'A', network: 'Cardano' }, DOGE: { name: 'Dogecoin', logo: 'Ð', network: 'Dogecoin' }, DOT: { name: 'Polkadot', logo: '●', network: 'Polkadot' }
};
const depositNetworkOptions = {
  BTC: ['Bitcoin'],
  ETH: ['Ethereum Mainnet', 'Arbitrum', 'Polygon'],
  BNB: ['BEP 20'],
  USDC: ['ERC 20', 'Arbitrum', 'Polygon'],
  USDT: ['ERC 20', 'BEP 20'],
  XRP: ['XRP Ledger'],
  SOL: ['Solana'],
  ADA: ['Cardano'],
  DOGE: ['Dogecoin'],
  DOT: ['Polkadot']
};
const knownDepositPairs = Object.entries(depositNetworkOptions).flatMap(([asset, networks]) =>
  networks.map((network) => ({ asset, network })),
);
let custodyCapabilities = { verified: false, pairs: [] };
let selectedAsset = 'ETH';
let selectedNetwork = 'Ethereum Mainnet';
let currentDepositAddress = '';
let currentDepositPair = null;
let marketChartTimer;

const apiRequest = async (path, options = {}) => {
  if (!API_BASE_URL) return null;
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(sessionStorage.getItem('orbitUserToken') ? { Authorization: `Bearer ${sessionStorage.getItem('orbitUserToken')}` } : {}), ...(options.headers || {}) }
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || `API request failed (${response.status}).`);
  }
  return response.json();
};

window.submitLogin = async (event) => {
  event.preventDefault();
  try {
    const account = await apiRequest('/auth/login', { method: 'POST', body: JSON.stringify({ email: $('email').value, password: $('password').value }) });
    if (account?.requiresOtp) beginVerification(account.challengeId, account.email, account.name, account.mailConfigured, account.devCode);
  } catch (error) {
    $('authStatus').textContent = error.message;
  }
};

window.submitSignup = async (event) => {
  event.preventDefault();
  if ($('signupPassword').value !== $('signupPasswordConfirm').value) { $('authStatus').textContent = 'Passwords do not match.'; return; }
  try {
    const account = await apiRequest('/auth/register', { method: 'POST', body: JSON.stringify({ email: $('signupEmail').value, password: $('signupPassword').value }) });
    if (account?.requiresOtp) beginVerification(account.challengeId, account.email, $('signupEmail').value.split('@')[0], account.mailConfigured, account.devCode);
  } catch (error) {
    $('authStatus').textContent = error.message;
  }
};

const loadGoogleIdentityServices = () => {
  if (window.google?.accounts?.id) return Promise.resolve();
  if (googleScriptPromise) return googleScriptPromise;
  googleScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = resolve;
    script.onerror = () => {
      googleScriptPromise = null;
      reject(new Error('Google sign-in could not load. Check your connection and try again.'));
    };
    document.head.appendChild(script);
  });
  return googleScriptPromise;
};

const showGoogleAccount = async (response) => {
  const payload = JSON.parse(atob(response.credential.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  try {
    const account = await apiRequest('/auth/google', { method: 'POST', body: JSON.stringify({ credential: response.credential }) });
    if (account?.user) payload.name = account.user.name || payload.name;
    if (account?.requiresOtp) {
      beginVerification(account.challengeId, account.email, payload.name || payload.given_name, account.mailConfigured, account.devCode);
      return;
    }
  } catch (error) {
    $('authStatus').textContent = error.message;
    return;
  }
  $('authView').classList.add('hidden');
  $('walletView').classList.remove('hidden');
  document.querySelector('.wallet-header h1').innerHTML = `Welcome, ${payload.given_name || payload.name || 'there'} <span class="wave" aria-hidden="true">+</span>`;
  loadWallet();
  toast(`Signed in with Google as ${payload.email}`);
};

const beginVerification = (challengeId, email, name = 'there', mailConfigured = false, devCode = '') => {
  sessionStorage.setItem('orbitVerification', JSON.stringify({ challengeId, email, name }));
  $('loginForm').classList.add('hidden');
  $('signupForm').classList.add('hidden');
  $('openSignup').classList.add('hidden');
  document.querySelector('.social-stack').classList.add('hidden');
  $('verificationForm').classList.remove('hidden');
  $('verificationMessage').textContent = mailConfigured ? `A 6-digit code was sent to ${email}.` : `Development mode: use code ${devCode || '(check the server terminal)'} Email delivery will be enabled after domain setup.`;
  $('verificationCode').focus();
};

const showLoginForm = () => {
  $('pendingApprovalView').classList.add('hidden');
  $('authView').classList.remove('hidden');
  $('verificationForm').classList.add('hidden');
  $('signupForm').classList.add('hidden');
  $('loginForm').classList.remove('hidden');
  $('openSignup').classList.remove('hidden');
  document.querySelector('.social-stack').classList.remove('hidden');
  sessionStorage.removeItem('orbitVerification');
  $('authStatus').textContent = '';
};

const showPendingApproval = (user = {}) => {
  sessionStorage.removeItem('orbitUserToken');
  sessionStorage.removeItem('orbitVerification');
  $('authView').classList.add('hidden');
  $('walletView').classList.add('hidden');
  $('pendingApprovalEmail').textContent = user.email || '';
  $('pendingApprovalView').classList.remove('hidden');
};

const completeLogin = (account) => {
  if (account?.pendingApproval || account?.user?.status === 'Pending') {
    showPendingApproval(account.user);
    return;
  }
  if (account?.token) sessionStorage.setItem('orbitUserToken', account.token);
  const verification = JSON.parse(sessionStorage.getItem('orbitVerification') || '{}');
  $('authView').classList.add('hidden');
  $('walletView').classList.remove('hidden');
  document.querySelector('.wallet-header h1').innerHTML = `Welcome, ${sessionStorage.getItem('walletDisplayName') || verification.name || account.user?.name || 'there'} <span class="wave" aria-hidden="true">+</span>`;
  sessionStorage.removeItem('orbitVerification');
  loadWallet();
  toast(`Signed in as ${account.user?.email || verification.email}`);
};

const loadWallet = async () => {
  try {
    const wallet = await apiRequest('/api/wallet');
    if (!wallet) return;
    currentUser = wallet.user;
    walletMode = wallet.walletMode;
    await refreshCustodyCapabilities();
    reconcileWalletSelection();
    document.querySelector('.wallet-header h1').innerHTML = `Welcome, ${wallet.user.name} <span class="wave" aria-hidden="true">+</span>`;
    currentDepositAddress = '';
    $('walletAddress').textContent = 'No deposit address';
    renderExchanges(wallet.transactions.map((transaction) => [transaction.date, transaction.status, transaction.status.toLowerCase(), transaction.pair.split(' - ')[0], transaction.pair.split(' - ')[1], 'Amount', transaction.amount]));
    renderInternalBalances(wallet.internalBalances || {});
    renderWalletRequests(wallet.requests || []);
    await loadSelectedBalance();
  } catch (error) {
    toast(error.message);
  }
};

const setProviderNotice = (title, message) => {
  $('providerNotice').querySelector('strong').textContent = title;
  $('providerNotice').querySelector('span').textContent = message;
};

const escapeMarkup = (value) => String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
const getSelectablePairs = () => walletMode === 'provider'
  ? (custodyCapabilities.verified ? custodyCapabilities.pairs : [])
  : knownDepositPairs;
const getSelectableAssets = () => [...new Set(getSelectablePairs().map(({ asset }) => asset))];
const getNetworksForAsset = (asset) => getSelectablePairs().filter((pair) => pair.asset === asset).map(({ network }) => network);
const isSelectablePair = (asset, network) => getSelectablePairs().some((pair) => pair.asset === asset && pair.network === network);
const refreshCustodyCapabilities = async () => {
  if (walletMode !== 'provider') {
    custodyCapabilities = { verified: false, pairs: [] };
    return;
  }
  try {
    const result = await apiRequest('/api/wallet/capabilities');
    if (!result?.verified || !Array.isArray(result.pairs)) throw new Error('The custody provider has not verified its supported networks.');
    const pairs = result.pairs.filter((pair) => pair && knownDepositPairs.some((known) => known.asset === pair.asset && known.network === pair.network));
    if (pairs.length !== result.pairs.length) throw new Error('The custody provider returned unsupported asset and network pairs.');
    custodyCapabilities = { verified: true, pairs };
  } catch (error) {
    custodyCapabilities = { verified: false, pairs: [] };
    setProviderNotice('Custody networks unavailable', error.message || 'The custody provider could not verify its supported networks.');
  }
};
const reconcileWalletSelection = () => {
  if (isSelectablePair(selectedAsset, selectedNetwork)) return;
  const first = getSelectablePairs()[0];
  setWalletSelection(first?.asset || '', first?.network || '');
};
const renderInternalBalances = (balances) => {
  const entries = Object.entries(balances);
  $('internalLedgerCard').classList.toggle('hidden', entries.length === 0);
  $('internalBalancesList').innerHTML = entries.map(([asset, amount]) => `<span class="internal-balance-pill">${escapeMarkup(asset)} ${escapeMarkup(amount)}</span>`).join('');
};
const renderWalletRequests = (requests) => {
  $('walletRequestSection').classList.toggle('hidden', requests.length === 0);
  $('walletRequestList').innerHTML = requests.map((item) => {
    const type = item.type === 'deposit' ? 'Deposit claim' : 'Withdrawal request';
    const amount = `${escapeMarkup(item.amount)} ${escapeMarkup(item.asset)}`;
    const detail = item.type === 'deposit' ? `Hash ${escapeMarkup(item.txHash || '')}` : `To ${escapeMarkup(item.recipient || '')}`;
    const payoutStatus = item.type === 'withdrawal' && item.status === 'Approved' ? (item.payoutStatus || 'Awaiting payout') : '';
    const visibleStatus = payoutStatus || item.status;
    const statusClass = visibleStatus.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const payoutDetail = item.payoutReference
      ? ` · Transaction reference ${escapeMarkup(item.payoutReference)}`
      : item.payoutStatus === 'Failed' && item.payoutError
        ? ` · Payout failed: ${escapeMarkup(item.payoutError)}`
        : '';
    return `<article class="wallet-request-row"><strong>${type} · ${amount}</strong><span class="exchange-status ${statusClass}">${escapeMarkup(visibleStatus)}</span><small>${escapeMarkup(item.network)} · ${escapeMarkup(new Date(item.createdAt).toLocaleDateString())} · ${detail}${payoutDetail}</small></article>`;
  }).join('');
};
const refreshWalletRequests = async () => {
  const result = await apiRequest('/api/wallet/requests');
  if (!result) return;
  renderInternalBalances(result.internalBalances || {});
  renderWalletRequests(result.requests || []);
};
const setWalletSelection = (asset, network) => {
  if (asset && network && !isSelectablePair(asset, network)) {
    asset = '';
    network = '';
  }
  selectedAsset = asset;
  selectedNetwork = network;
  currentDepositAddress = '';
  currentDepositPair = null;
  $('walletAddress').textContent = 'No deposit address';
  $('walletBalanceAsset').textContent = asset || '—';
  $('openAssets').textContent = `◉ ${asset || '—'}`;
  $('openNetwork').innerHTML = `${network || 'No verified network'} <span>⌄</span>`;
};
const loadSelectedBalance = async () => {
  $('walletBalanceValue').textContent = '—';
  $('walletBalanceAsset').textContent = selectedAsset || '—';
  if (!selectedAsset || !selectedNetwork || !isSelectablePair(selectedAsset, selectedNetwork)) {
    if (walletMode === 'provider') setProviderNotice('Custody networks unavailable', 'No asset and network pair is currently verified by the configured custody provider.');
    return;
  }
  try {
    const query = new URLSearchParams({ asset: selectedAsset, network: selectedNetwork });
    const result = await apiRequest(`/api/wallet/balance?${query}`);
    if (!result?.verified || result.asset !== selectedAsset || result.network !== selectedNetwork || typeof result.balance !== 'string') {
      throw new Error('The custody API did not verify this balance.');
    }
    $('walletBalanceValue').textContent = result.balance;
    setProviderNotice('Custody API verified', `Showing the verified ${selectedAsset} balance for this account on ${selectedNetwork}. Deposit addresses are checked separately before display.`);
  } catch (error) {
    if (!/No verified deposit address has been issued/i.test(error.message)) {
      setProviderNotice('Custody balance unavailable', error.message);
    }
  }
};
const copyDepositAddress = async () => {
  if (!currentDepositAddress) { openReceive(); return; }
  try {
    await navigator.clipboard.writeText(currentDepositAddress);
    toast('Deposit address copied');
  } catch {
    toast('Unable to copy the deposit address');
  }
};

const loadMarket = async () => {
  try {
    const market = await apiRequest('/api/market');
    if (!market || !$('marketGrid')) return;
    $('marketGrid').innerHTML = Object.entries(market.quotes).map(([symbol, quote]) => `<button class="market-card" data-symbol="${symbol}"><div><span class="asset-logo logo-${symbol.toLowerCase()}">${coinData[symbol]?.logo || '◆'}</span><strong>${coinData[symbol]?.name || symbol}</strong><small>${symbol}/USD</small></div><b>$${quote.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 8 })}</b><span class="market-change ${quote.change >= 0 ? 'up' : 'down'}">${quote.change >= 0 ? '+' : ''}${quote.change}%</span></button>`).join('');
    document.querySelectorAll('.market-card').forEach((card) => card.addEventListener('click', () => openMarketChart(card.dataset.symbol, market.quotes[card.dataset.symbol])));
    $('marketUpdated').textContent = `${market.source === 'Binance' ? 'Live Binance' : 'Provider unavailable'} · ${new Date(market.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  } catch (error) {
    if ($('marketUpdated')) $('marketUpdated').textContent = 'Market unavailable';
  }
};
loadMarket();
setInterval(loadMarket, 3000);

const oauthParams = new URLSearchParams(window.location.search);
if (oauthParams.get('authError')) $('authStatus').textContent = oauthParams.get('authError');
if (oauthParams.get('oauthChallenge')) beginVerification(oauthParams.get('oauthChallenge'), oauthParams.get('email'), oauthParams.get('name'), oauthParams.get('mailConfigured') === 'true', oauthParams.get('devCode'));
if (window.location.search) window.history.replaceState({}, document.title, window.location.pathname);

const renderGoogleSignInButton = async () => {
  if (googleIdentityInitialized) return;
  await loadGoogleIdentityServices();
  const slot = $('googleSignInButton');
  if (!slot || !publicConfig?.googleClientId) return;
  google.accounts.id.initialize({ client_id: publicConfig.googleClientId, callback: showGoogleAccount });
  google.accounts.id.renderButton(slot, {
    type: 'standard',
    theme: 'filled_black',
    size: 'large',
    text: 'continue_with',
    shape: 'rectangular',
    width: Math.floor(slot.getBoundingClientRect().width),
    logo_alignment: 'left'
  });
  googleIdentityInitialized = true;
};

const networks = [
  { name: 'Ethereum', short: 'ETH', color: '#627eea', icon: '◆', chainId: '0x1', selected: true },
  { name: 'BNB Chain', short: 'BNB', color: '#f3ba2f', icon: '◇', chainId: '0x38', selected: false },
  { name: 'Polygon', short: 'POL', color: '#8247e5', icon: '⬡', chainId: '0x89', selected: false },
  { name: 'Arbitrum', short: 'ARB', color: '#28a0f0', icon: '◆', chainId: '0xa4b1', selected: false }
];
const exchanges = [];
const toast = (message) => { const el = $('toast'); el.textContent = message; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 2200); };
const coins = (first, second) => `<div class="coin-icons"><span class="coin ${first.toLowerCase()}">${first === 'BTC' ? '₿' : first === 'ETH' ? '◆' : first === 'BNB' ? '✦' : '$'}</span><span class="coin ${second.toLowerCase()}">${second === 'BTC' ? '₿' : second === 'ETH' ? '◆' : '$'}</span></div>`;
const renderExchanges = (items) => { $('exchangeGrid').innerHTML = items.length ? items.map(([date, status, state, first, second, label, value], index) => `<article class="exchange-card" data-exchange="${index}" tabindex="0" role="button"><div class="exchange-date"><span>${date}</span><span class="exchange-status ${state}">${status}</span></div><div class="exchange-pair">${coins(first, second)}<span>${first} - ${second}</span></div><div class="exchange-label">${label}</div><div class="exchange-value">${value}</div></article>`).join('') : '<p class="chart-caption">No wallet activity is available. Activity will appear after a verified wallet provider is configured.</p>'; bindExchangeCards(); };
renderExchanges(exchanges);
$('networkList').innerHTML = networks.map((network, index) => `<div class="network-row"><span class="network-icon" style="background:${network.color}22;color:${network.color}">${network.icon}</span><span>${network.name}</span><button class="network-check" data-index="${index}" aria-label="Select ${network.name}">${network.selected ? '✓' : ''}</button></div>`).join('');
const openModal = () => $('networkModal').classList.remove('hidden');
const openAction = (title, body, buttonText = 'Continue') => {
  $('actionTitle').textContent = title;
  $('actionBody').textContent = body;
  $('actionButton').textContent = buttonText;
  $('actionButton').style.display = buttonText ? 'block' : 'none';
  $('actionModal').classList.remove('hidden');
};
const openMarketChart = async (symbol, quote) => {
  const coin = coinData[symbol] || { name: symbol, logo: '◆' };
  const chart = await apiRequest(`/api/market/chart/${symbol}`).catch(() => null);
  openAction(`${coin.logo} ${coin.name}`, '', '');
  const renderChart = (data) => { const closes = data?.candles?.map((candle) => candle.close) || [quote.price]; const minimum = Math.min(...closes); const maximum = Math.max(...closes); const range = maximum - minimum || 1; const points = closes.map((value, index) => `${(index / Math.max(closes.length - 1, 1)) * 308},${88 - ((value - minimum) / range) * 76}`).join(' '); $('actionBody').innerHTML = `<div class="chart-price" id="chartPrice">$${closes.at(-1).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 8 })}<span class="market-change ${quote.change >= 0 ? 'up' : 'down'}">${quote.change >= 0 ? '+' : ''}${quote.change}% today</span></div><svg class="market-chart" viewBox="0 0 308 100" role="img" aria-label="${coin.name} live price chart"><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg><p class="chart-caption">Real ${data?.source || 'provider'} 1-minute candles · refreshed every 3 seconds.</p>`; };
  renderChart(chart);
  clearInterval(marketChartTimer);
  marketChartTimer = setInterval(async () => { const latest = await apiRequest(`/api/market/chart/${symbol}`).catch(() => null); if (latest?.candles?.length && $('chartPrice')) renderChart(latest); }, 3000);
};
const openReceive = async () => {
  await refreshCustodyCapabilities();
  reconcileWalletSelection();
  openAction('Receive or report a deposit', '', '');
  currentDepositAddress = '';
  currentDepositPair = null;
  $('walletAddress').textContent = 'No deposit address';
  const selectableAssets = getSelectableAssets();
  const assetChoices = selectableAssets.length
    ? selectableAssets.map((symbol) => `<option value="${symbol}">${coinData[symbol].logo} ${coinData[symbol].name} (${symbol})</option>`).join('')
    : '<option value="">No verified assets available</option>';
  const providerButtonClass = walletMode === 'provider' ? 'done-button' : 'done-button hidden';
  $('actionBody').innerHTML = `<form class="wallet-form" id="receiveForm"><label class="modal-label">Asset<select id="receiveAsset">${assetChoices}</select></label><label class="modal-label">Network<select id="receiveNetwork"></select></label><button class="${providerButtonClass}" id="requestDepositAddress" type="submit">Get verified account-specific address</button><button class="done-button hidden" id="showSharedDepositAddress" type="button">Show shared address</button><p class="form-note" id="receiveNote" role="status"></p><div class="hidden" id="receiveAddressPanel"><div class="wallet-address-box"><code id="receiveAddress"></code><button class="copy-small" id="copyReceiveAddress" type="button">Copy</button></div><p class="form-note" id="receiveInstructions"></p></div></form><div class="deposit-claim"><h3>Report a deposit</h3><label class="modal-label">Amount<input id="depositClaimAmount" type="number" min="0.000000000000000001" step="any" required /></label><label class="modal-label">Transaction hash<input id="depositClaimHash" maxlength="256" required /></label><button class="done-button" id="depositClaimButton" type="button">Submit for admin review</button><p class="form-note" id="depositClaimNote" role="status">A claim stays pending until an admin checks the hash. Approval adds to the separate internal ledger, not the custody balance.</p></div>`;
  $('receiveAsset').value = selectedAsset;
  const updateReceiveNetworks = () => {
    const asset = $('receiveAsset').value;
    const options = getNetworksForAsset(asset);
    $('receiveNetwork').innerHTML = options.length
      ? options.map((network) => `<option value="${escapeMarkup(network)}">${escapeMarkup(network)}</option>`).join('')
      : '<option value="">No verified networks available</option>';
    $('receiveNetwork').value = options.includes(selectedNetwork) ? selectedNetwork : (options[0] || '');
  };
  const updateReceiveOptions = () => {
    const asset = $('receiveAsset').value;
    const network = $('receiveNetwork').value;
    const pairAvailable = isSelectablePair(asset, network);
    const sharedAvailable = pairAvailable && Array.isArray(publicConfig?.sharedDepositPairs)
      && publicConfig.sharedDepositPairs.some((pair) => pair.asset === asset && pair.network === network);
    $('showSharedDepositAddress').classList.toggle('hidden', !sharedAvailable);
    $('requestDepositAddress').disabled = walletMode === 'provider' && !pairAvailable;
    $('depositClaimButton').disabled = !pairAvailable;
    if (sharedAvailable && walletMode === 'provider') {
      $('receiveNote').textContent = 'Choose a verified account-specific address or a shared address. Shared deposits cannot be attributed automatically and require admin review.';
    } else if (sharedAvailable) {
      $('receiveNote').textContent = 'A shared address is available, but deposits cannot be attributed automatically. Submit the transaction hash and amount for admin review.';
    } else if (walletMode === 'provider') {
      $('receiveNote').textContent = pairAvailable
        ? 'The address appears only after the custody API verifies it for your account.'
        : 'No asset and network pair is currently verified by the configured custody provider.';
    } else {
      $('receiveNote').textContent = 'A verified or shared address is unavailable for this network. Do not send funds to an unverified address. You can report an already-sent deposit for manual review.';
    }
  };
  const invalidateReceiveAddress = () => {
    if (currentDepositPair && (currentDepositPair.asset !== $('receiveAsset').value || currentDepositPair.network !== $('receiveNetwork').value)) {
      currentDepositPair = null;
      currentDepositAddress = '';
      $('receiveAddressPanel').classList.add('hidden');
      $('receiveAddress').textContent = '';
      $('walletAddress').textContent = 'No deposit address';
    }
  };
  updateReceiveNetworks();
  updateReceiveOptions();
  $('receiveAsset').addEventListener('change', () => { updateReceiveNetworks(); invalidateReceiveAddress(); updateReceiveOptions(); });
  $('receiveNetwork').addEventListener('change', () => { invalidateReceiveAddress(); updateReceiveOptions(); });
  const requestReceiveAddress = async (shared) => {
    if (!shared && walletMode === 'demo') return;
    const asset = $('receiveAsset').value;
    const network = $('receiveNetwork').value;
    const note = $('receiveNote');
    const submit = shared ? $('showSharedDepositAddress') : $('requestDepositAddress');
    if (!isSelectablePair(asset, network)) {
      note.textContent = 'This asset and network is not currently verified as supported.';
      return;
    }
    $('receiveAddressPanel').classList.add('hidden');
    currentDepositAddress = '';
    $('walletAddress').textContent = 'No deposit address';
    note.textContent = shared ? 'Loading the shared address...' : 'Verifying the custody API and requesting your account-specific address...';
    submit.disabled = true;
    $('receiveAsset').disabled = true;
    $('receiveNetwork').disabled = true;
    try {
      const query = new URLSearchParams({ network });
      if (shared) query.set('shared', 'true');
      const result = await apiRequest(`/api/wallet/receive/${encodeURIComponent(asset)}?${query}`);
      const responseMatchesMode = shared
        ? result?.shared === true && result.verified === false
        : result?.verified === true && result.shared !== true;
      if (!responseMatchesMode || result.asset !== asset || result.network !== network || typeof result.address !== 'string') {
        throw new Error(shared
          ? 'A shared address is unavailable for this asset and network.'
          : 'The custody API did not verify an address for this account, asset, and network.');
      }
      setWalletSelection(asset, network);
      currentDepositAddress = result.address;
      currentDepositPair = { asset, network };
      $('walletAddress').textContent = `${shared ? 'Shared: ' : ''}${result.address.slice(0, 7)}…${result.address.slice(-5)}`;
      $('receiveAddress').textContent = result.address;
      $('receiveInstructions').textContent = shared
        ? `This is a shared ${asset} address on ${network}, not an account-specific address. Deposits cannot be automatically attributed or credited. Submit the transaction hash and amount for admin review; only an admin-approved claim adds funds to the separate internal ledger.`
        : `Send only ${asset} on ${network} to this account-specific address.`;
      $('depositClaimNote').textContent = shared
        ? 'Shared-address deposits are not automatically attributed or credited. Submit the transaction hash and amount; an admin must review and approve the claim before the separate internal ledger is credited.'
        : 'A claim stays pending until an admin checks the hash. Approval adds to the separate internal ledger, not the custody balance.';
      $('receiveAddressPanel').classList.remove('hidden');
      if (shared) {
        note.textContent = 'Shared address loaded. This address is not assigned to your account and requires manual admin review.';
        setProviderNotice('Shared address · manual review', `${asset} deposits to the shared ${network} address are not automatically attributed or credited.`);
      } else {
        note.textContent = `${result.provider} verified this deposit address for your account.`;
        setProviderNotice('Custody API verified', `Your ${asset} deposit address is unique to this account on ${network}.`);
        await loadSelectedBalance();
      }
    } catch (error) {
      note.textContent = error.message || 'A verified deposit address is unavailable.';
      setProviderNotice('Deposits unavailable', note.textContent);
    } finally {
      $('receiveAsset').disabled = false;
      $('receiveNetwork').disabled = false;
      updateReceiveOptions();
    }
  };
  $('receiveForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    await requestReceiveAddress(false);
  });
  $('showSharedDepositAddress').addEventListener('click', () => requestReceiveAddress(true));
  $('copyReceiveAddress').addEventListener('click', async () => {
    if (!currentDepositAddress) return;
    try {
      await navigator.clipboard.writeText(currentDepositAddress);
      toast('Deposit address copied');
    } catch {
      toast('Unable to copy the deposit address');
    }
  });
  $('depositClaimButton').addEventListener('click', async () => {
    const amount = $('depositClaimAmount').value;
    const txHash = $('depositClaimHash').value.trim();
    const note = $('depositClaimNote');
    const submit = $('depositClaimButton');
    if (!isSelectablePair($('receiveAsset').value, $('receiveNetwork').value)) {
      note.textContent = 'Choose an asset and network verified as supported before submitting a deposit claim.';
      return;
    }
    if (!amount || !$('depositClaimHash').reportValidity()) return;
    submit.disabled = true;
    note.textContent = 'Submitting your claim for admin review...';
    try {
      const result = await apiRequest('/api/wallet/deposit-requests', { method: 'POST', body: JSON.stringify({ asset: $('receiveAsset').value, network: $('receiveNetwork').value, amount, txHash }) });
      note.textContent = `Deposit claim ${result.id.slice(0, 8)} submitted. It remains pending until an admin approves it.`;
      $('depositClaimHash').value = '';
      $('depositClaimAmount').value = '';
      await refreshWalletRequests();
    } catch (error) {
      note.textContent = error.message || 'Unable to submit this deposit claim.';
    } finally {
      submit.disabled = false;
    }
  });
};
const openAssetSelector = async () => {
  await refreshCustodyCapabilities();
  reconcileWalletSelection();
  openAction('Select asset', '', '');
  const assets = getSelectableAssets();
  const assetOptions = assets.length
    ? assets.map((symbol) => `<option value="${symbol}">${coinData[symbol].logo} ${coinData[symbol].name} (${symbol})</option>`).join('')
    : '<option value="">No verified assets available</option>';
  $('actionBody').innerHTML = `<form class="wallet-form" id="assetSelectionForm"><label class="modal-label">Asset<select id="selectedAssetInput">${assetOptions}</select></label><button class="done-button" id="assetSelectionSubmit" type="submit" ${assets.length ? '' : 'disabled'}>Show verified balance</button><p class="form-note">${assets.length ? 'Balances are loaded from the custody API for this ARC account only.' : 'No asset and network pair is currently verified by the configured custody provider.'}</p></form>`;
  $('selectedAssetInput').value = selectedAsset;
  $('assetSelectionForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const asset = $('selectedAssetInput').value;
    const network = getNetworksForAsset(asset)[0];
    if (!network) return;
    setWalletSelection(asset, network);
    $('actionModal').classList.add('hidden');
    await loadSelectedBalance();
  });
};
const openNetworkSelector = async () => {
  await refreshCustodyCapabilities();
  reconcileWalletSelection();
  openAction('Select network', '', '');
  const options = getNetworksForAsset(selectedAsset);
  $('actionBody').innerHTML = `<form class="wallet-form" id="networkSelectionForm"><label class="modal-label">Network<select id="selectedNetworkInput">${options.length ? options.map((network) => `<option value="${escapeMarkup(network)}">${escapeMarkup(network)}</option>`).join('') : '<option value="">No verified networks available</option>'}</select></label><button class="done-button" type="submit" ${options.length ? '' : 'disabled'}>Show verified balance</button><p class="form-note">${options.length ? 'Only provider-verified asset and network combinations are accepted.' : 'No network is currently verified for this asset.'}</p></form>`;
  $('selectedNetworkInput').value = options.includes(selectedNetwork) ? selectedNetwork : options[0];
  $('networkSelectionForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!options.includes($('selectedNetworkInput').value)) return;
    setWalletSelection(selectedAsset, $('selectedNetworkInput').value);
    $('actionModal').classList.add('hidden');
    await loadSelectedBalance();
  });
};
const openSend = async () => {
  await refreshCustodyCapabilities();
  reconcileWalletSelection();
  openAction('Request withdrawal', '', '');
  const assets = getSelectableAssets();
  const assetChoices = assets.length
    ? assets.map((symbol) => `<option value="${symbol}">${coinData[symbol].logo} ${coinData[symbol].name} (${symbol})</option>`).join('')
    : '<option value="">No verified assets available</option>';
  $('actionBody').innerHTML = `<form class="wallet-form" id="withdrawalForm"><label class="modal-label">Asset<select id="withdrawalAsset">${assetChoices}</select></label><label class="modal-label">Network<select id="withdrawalNetwork"></select></label><label class="modal-label">Amount<input id="withdrawalAmount" type="number" min="0.000000000000000001" step="any" required /></label><label class="modal-label">Destination address<input id="withdrawalRecipient" maxlength="250" required /></label><button class="done-button" id="withdrawalSubmit" type="submit" ${assets.length ? '' : 'disabled'}>Submit withdrawal request</button><p class="form-note" id="withdrawalNote" role="status">${assets.length ? 'This request is checked against your internal adjustment balance and stays pending until admin review. No on-chain transfer is sent; custody balances are separate.' : 'No asset and network pair is currently verified by the configured custody provider.'}</p></form>`;
  $('withdrawalAsset').value = selectedAsset;
  const updateWithdrawalNetworks = () => {
    const asset = $('withdrawalAsset').value;
    const options = getNetworksForAsset(asset);
    $('withdrawalNetwork').innerHTML = options.length
      ? options.map((network) => `<option value="${escapeMarkup(network)}">${escapeMarkup(network)}</option>`).join('')
      : '<option value="">No verified networks available</option>';
    $('withdrawalNetwork').value = options.includes(selectedNetwork) ? selectedNetwork : (options[0] || '');
    $('withdrawalSubmit').disabled = !options.length;
  };
  updateWithdrawalNetworks();
  $('withdrawalAsset').addEventListener('change', updateWithdrawalNetworks);
  $('withdrawalForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = $('withdrawalSubmit');
    const note = $('withdrawalNote');
    if (!isSelectablePair($('withdrawalAsset').value, $('withdrawalNetwork').value)) {
      note.textContent = 'Choose an asset and network verified as supported before submitting a withdrawal request.';
      return;
    }
    submit.disabled = true;
    note.textContent = 'Submitting your withdrawal for admin review...';
    try {
      const result = await apiRequest('/api/wallet/withdrawal-requests', { method: 'POST', body: JSON.stringify({ asset: $('withdrawalAsset').value, network: $('withdrawalNetwork').value, amount: $('withdrawalAmount').value, recipient: $('withdrawalRecipient').value.trim() }) });
      note.textContent = `Withdrawal request ${result.id.slice(0, 8)} is pending admin review. No blockchain transfer was initiated.`;
      $('withdrawalForm').reset();
      updateWithdrawalNetworks();
      await refreshWalletRequests();
    } catch (error) {
      note.textContent = error.message || 'Unable to submit this withdrawal request.';
    } finally {
      updateWithdrawalNetworks();
    }
  });
};
const openExchange = () => {
  openAction('Exchange assets', '', '');
  const exchangeOptions = Object.entries(coinData).map(([symbol, coin]) => `<option value="${symbol}">${coin.logo}  ${coin.name} (${symbol})</option>`).join('');
  $('actionBody').innerHTML = `<form class="wallet-form" id="exchangeForm"><div class="exchange-pair-form"><label class="modal-label">From<select id="exchangeFrom">${exchangeOptions}</select></label><button class="swap-assets" id="swapAssets" type="button">⇄</button><label class="modal-label">To<select id="exchangeTo">${exchangeOptions}</select></label></div><label class="modal-label">Amount<input id="exchangeAmount" type="number" min="0" step="any" placeholder="0.00" required /></label><div class="exchange-rate" id="exchangeRate"></div><button class="done-button" type="submit">Preview only</button><p class="form-note" id="exchangeNote">Demo preview only. No trade will be submitted or executed.</p></form>`;
  $('exchangeTo').value = 'ETH';
  const updateRate = () => { const from = $('exchangeFrom').value; const to = $('exchangeTo').value; $('exchangeRate').textContent = `${coinData[from].name} → ${coinData[to].name} · indicative preview only`; };
  $('exchangeFrom').addEventListener('change', updateRate); $('exchangeTo').addEventListener('change', updateRate); updateRate();
  $('swapAssets').addEventListener('click', () => { const current = $('exchangeFrom').value; $('exchangeFrom').value = $('exchangeTo').value; $('exchangeTo').value = current; updateRate(); });
  $('exchangeForm').addEventListener('submit', (event) => { event.preventDefault(); $('exchangeNote').textContent = `Demo preview: ${$('exchangeAmount').value} ${$('exchangeFrom').value} to ${$('exchangeTo').value}. No trade was executed.`; });
};
const openSettings = () => {
  openAction('Settings', '', '');
  const profileMarkup = `<form class="wallet-form" id="profileForm"><label class="modal-label">Display name<input id="profileName" value="${currentUser?.name || ''}" required /></label><label class="modal-label">Email<input type="email" value="${currentUser?.email || ''}" readonly /></label><button class="done-button" type="submit">Save profile</button><p class="form-note" id="profileNote"></p></form>`;
  $('actionBody').innerHTML = `<div class="settings-tabs"><button class="settings-tab active" data-settings="profile">Profile</button><button class="settings-tab" data-settings="security">Security</button></div><div id="settingsPanel">${profileMarkup}</div>`;
  const bindProfile = () => $('profileForm').addEventListener('submit', async (event) => { event.preventDefault(); try { const result = await apiRequest('/api/wallet/profile', { method: 'PATCH', body: JSON.stringify({ name: $('profileName').value }) }); currentUser = result.user; document.querySelector('.wallet-header h1').innerHTML = `Welcome, ${currentUser.name} <span class="wave">✦</span>`; $('profileNote').textContent = 'Profile saved.'; } catch (error) { $('profileNote').textContent = error.message; } });
  bindProfile();
  const renderSecurity = () => { $('settingsPanel').innerHTML = `<form class="wallet-form" id="securityForm"><label class="modal-label">Current password<input id="currentPassword" type="password" required /></label><label class="modal-label">New password<input id="newPassword" type="password" minlength="8" required /></label><button class="done-button" type="submit">Update password</button></form><p class="form-note" id="securityNote"></p>`; $('securityForm').addEventListener('submit', async (event) => { event.preventDefault(); try { await apiRequest('/api/wallet/password', { method: 'PATCH', body: JSON.stringify({ currentPassword: $('currentPassword').value, newPassword: $('newPassword').value }) }); $('securityNote').textContent = 'Password updated.'; event.target.reset(); } catch (error) { $('securityNote').textContent = error.message; } }); };
  document.querySelectorAll('.settings-tab').forEach((tab) => tab.addEventListener('click', () => { document.querySelectorAll('.settings-tab').forEach((item) => item.classList.remove('active')); tab.classList.add('active'); if (tab.dataset.settings === 'security') renderSecurity(); else { $('settingsPanel').innerHTML = profileMarkup; bindProfile(); } }));
};
$('openNetwork').addEventListener('click', openNetworkSelector);
$('copyAddress').addEventListener('click', copyDepositAddress);
$('closeNetwork').addEventListener('click', () => $('networkModal').classList.add('hidden'));
$('closeAction').addEventListener('click', () => { $('actionModal').classList.add('hidden'); clearInterval(marketChartTimer); });
$('openAssets').addEventListener('click', openAssetSelector);
$('openReceive').addEventListener('click', openReceive);
$('openSend').addEventListener('click', openSend);
$('openProfile').addEventListener('click', openSettings);
$('openMore').addEventListener('click', () => openAction('Wallet options', 'Manage wallet visibility, export options and connected devices.', 'Manage wallet'));
$('openExchange').addEventListener('click', openExchange);
$('actionButton').addEventListener('click', () => { $('actionModal').classList.add('hidden'); toast('This action is ready to continue'); });
$('doneNetwork').addEventListener('click', () => $('networkModal').classList.add('hidden'));
document.querySelectorAll('.network-check').forEach((button) => button.addEventListener('click', () => { networks.forEach((network) => network.selected = false); networks[button.dataset.index].selected = true; document.querySelectorAll('.network-check').forEach((item) => item.textContent = ''); button.textContent = '✓'; }));
document.querySelector('.select-all input').addEventListener('change', (event) => {
  networks.forEach((network) => network.selected = event.target.checked);
  document.querySelectorAll('.network-check').forEach((item) => item.textContent = event.target.checked ? '✓' : '');
});
document.querySelectorAll('.social-button').forEach((button) => button.addEventListener('click', () => {
  if (button.dataset.provider === 'Google') {
    signInWithGoogle();
    return;
  }
  if (button.dataset.provider === 'X') { window.location.href = '/auth/x/start'; return; }
  if (button.dataset.provider === 'VK') { window.location.href = '/auth/vk/start'; return; }
  $('authStatus').textContent = `${button.dataset.provider} OAuth is not configured yet. Add its OAuth client credentials on the server first.`;
}));
const configureAuthProviders = async () => {
  try {
    publicConfig = await apiRequest('/api/config');
    document.querySelectorAll('.social-button').forEach((button) => {
      const provider = button.dataset.provider.toLowerCase();
      button.classList.toggle('hidden', !publicConfig.providers?.[provider]);
    });
    const googleSlot = $('googleSignInButton');
    const googleAvailable = Boolean(publicConfig.providers?.google && publicConfig.googleClientId);
    googleSlot?.classList.toggle('hidden', !googleAvailable);
    if (googleAvailable) await renderGoogleSignInButton();
  } catch (error) {
    $('authStatus').textContent = error.message || 'Unable to load sign-in configuration.';
  }
};
configureAuthProviders();
$('openSignup').addEventListener('click', () => { $('loginForm').classList.add('hidden'); $('openSignup').classList.add('hidden'); $('signupForm').classList.remove('hidden'); $('authStatus').textContent = ''; });
$('backToLogin').addEventListener('click', showLoginForm);
$('pendingBackToLogin').addEventListener('click', showLoginForm);
$('verificationForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const verification = JSON.parse(sessionStorage.getItem('orbitVerification') || '{}');
  try {
    const account = await apiRequest('/auth/verify-otp', { method: 'POST', body: JSON.stringify({ challengeId: verification.challengeId, code: $('verificationCode').value }) });
    completeLogin(account);
  } catch (error) {
    $('authStatus').textContent = error.message;
  }
});
$('password').nextElementSibling.addEventListener('click', (event) => { const input = $('password'); input.type = input.type === 'password' ? 'text' : 'password'; event.currentTarget.textContent = input.type === 'password' ? '◉' : '◎'; });
$('forgotLink').addEventListener('click', (event) => { event.preventDefault(); toast('Password reset link requested'); });
$('viewAll').addEventListener('click', () => toast('Showing all exchanges'));
function bindExchangeCards() { document.querySelectorAll('.exchange-card').forEach((card) => {
  const openDetails = () => {
    const [date, status, , first, second, label, value] = exchanges[card.dataset.exchange];
    openAction(`${first} - ${second} exchange`, `${date} · ${status} · ${label} ${value}`, 'Close');
  };
  card.addEventListener('click', openDetails);
  card.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openDetails(); } });
}); }
document.querySelectorAll('.nav-item').forEach((item) => item.addEventListener('click', () => {
  document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.remove('active'));
  item.classList.add('active');
  const tab = item.dataset.tab;
  if (tab === 'wallet') {
    toast('Wallet home opened');
  } else if (tab === 'exchange') {
    openExchange();
  } else {
    openSettings();
  }
}));
