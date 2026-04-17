// student-store.js — Store rendering, cart, orders, address, product reviews, virtual goods, group buys

function renderStore() {
  const productsRoot = document.getElementById('student-products-list');
  const ordersRoot = document.getElementById('student-orders-list');

  productsRoot.innerHTML = studentState.data.products.length
    ? studentState.data.products
        .map(
          (product) => `
            <article class="store-card">
              <div class="card-head">
                <div>
                  <h3>${escapeHtml(product.title)}</h3>
                  <p class="muted">${escapeHtml(product.description || '暂无商品说明')}</p>
                  ${product.category ? `<span class="badge" style="margin-top:4px;">${escapeHtml(product.category)}</span>` : ''}
                </div>
                <div>
                  <div class="badge badge-brand">${escapeHtml(formatMoney(product.price))}</div>
                  <div class="badge">库存 ${escapeHtml(product.stock)}</div>
                </div>
              </div>
              ${product.imagePath ? `<img class="image-preview" src="${escapeHtml(product.imagePath)}" alt="${escapeHtml(product.title)}" />` : ''}
              <div class="inline-actions" style="margin-top:14px;">
                <button class="ghost-button" data-action="add-to-cart" data-id="${product.id}" type="button" style="font-size:12px;padding:6px 14px;">加入购物车</button>
              </div>
            </article>
          `
        )
        .join('')
    : buildEmptyState('暂无资料商品', '老师上架后可直接购买。');

  ordersRoot.innerHTML = studentState.data.orders.length
    ? studentState.data.orders
        .map(
          (order) => `
            <article class="order-card">
              <div class="card-head">
                <div>
                  <h3>${escapeHtml(order.productTitle)}</h3>
                  <p class="muted">数量 ${escapeHtml(order.quantity)} · ${escapeHtml(order.shippingAddress)}</p>
                </div>
                <div>
                  <div class="badge badge-brand">${escapeHtml(formatMoney(order.totalAmount))}</div>
                  <div class="badge">${escapeHtml(order.status)}</div>
                </div>
              </div>
              <div style="margin-top:8px;display:flex;gap:8px;">
                ${order.status === 'delivered' ? `<button class="button" data-action="confirm-order" data-id="${order.id}" type="button" style="font-size:12px;padding:6px 14px;">确认收货</button>` : ''}
                ${order.status === 'confirmed' && order.productId ? `<button class="ghost-button" data-action="review-product" data-product-id="${order.productId}" data-title="${escapeHtml(order.productTitle)}" type="button" style="font-size:12px;padding:6px 14px;">评价商品</button>` : ''}
              </div>
            </article>
          `
        )
        .join('')
    : buildEmptyState('还没有订单', '在上方加入购物车下单。');
  loadCart();
}

// ── 购物车 ──

async function loadCart() {
  try {
    const result = await fetchJSON('/api/cart');
    renderCart(result.items);
  } catch (error) {
    createToast(error.message, 'error');
  }
}

function renderCart(items) {
  const root = document.getElementById('cart-items-list');
  const checkoutArea = document.getElementById('cart-checkout-area');

  if (!items.length) {
    root.innerHTML = '<p class="muted" style="font-size:13px;">购物车为空。</p>';
    checkoutArea.classList.add('hidden');
    return;
  }

  checkoutArea.classList.remove('hidden');
  let totalAmount = 0;
  root.innerHTML = items.map((item) => {
    const subtotal = item.price * item.quantity;
    totalAmount += subtotal;
    return `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--line);">
        <div>
          <strong style="font-size:13px;">${escapeHtml(item.title)}</strong>
          <span class="muted" style="margin-left:8px;font-size:12px;">${formatMoney(item.price)} x ${item.quantity}</span>
        </div>
        <div style="display:flex;gap:6px;align-items:center;">
          <span style="font-size:13px;font-weight:600;">${formatMoney(subtotal)}</span>
          <button class="ghost-button" data-action="remove-cart" data-id="${item.id}" type="button" style="font-size:11px;padding:2px 8px;color:#ef4444;">移除</button>
        </div>
      </div>
    `;
  }).join('') + `<div style="text-align:right;padding:10px 0;font-weight:600;">合计：${formatMoney(totalAmount)}</div>`;

  loadAddresses();
}

function bindCartEvents() {
  document.getElementById('student-products-list').addEventListener('click', async (event) => {
    const addBtn = event.target.closest('[data-action="add-to-cart"]');
    if (!addBtn) return;
    try {
      await fetchJSON('/api/cart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: addBtn.dataset.id, quantity: 1 })
      });
      createToast('已加入购物车。', 'success');
      loadCart();
    } catch (error) {
      createToast(error.message, 'error');
    }
  });

  document.getElementById('cart-items-list').addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-action="remove-cart"]');
    if (!btn) return;
    try {
      await fetchJSON('/api/cart/' + btn.dataset.id, { method: 'DELETE' });
      createToast('已移除。', 'success');
      loadCart();
    } catch (error) {
      createToast(error.message, 'error');
    }
  });

  document.getElementById('cart-checkout-btn').addEventListener('click', async () => {
    const addressId = document.getElementById('cart-address-select').value;
    if (!addressId) { createToast('请选择收货地址。', 'error'); return; }
    const btn = document.getElementById('cart-checkout-btn');
    setButtonLoading(btn, true);
    try {
      const result = await fetchJSON('/api/cart/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addressId: Number(addressId) })
      });
      createToast(`下单成功，共 ${result.created} 个订单。`, 'success');
      loadCart();
      refreshStudentData();
    } catch (error) {
      createToast(error.message, 'error');
    } finally {
      setButtonLoading(btn, false);
    }
  });

  document.getElementById('cart-manage-address').addEventListener('click', () => {
    document.getElementById('address-manager').classList.toggle('hidden');
  });
}

// ── 地址簿 ──

async function loadAddresses() {
  try {
    const result = await fetchJSON('/api/addresses');
    renderAddresses(result.addresses);
  } catch (_) {}
}

function renderAddresses(addresses) {
  const sel = document.getElementById('cart-address-select');
  sel.innerHTML = '<option value="">选择收货地址</option>' +
    addresses.map((a) => `<option value="${a.id}">${escapeHtml(a.name)} ${escapeHtml(a.phone)} - ${escapeHtml(a.address)}</option>`).join('');

  const root = document.getElementById('address-list');
  root.innerHTML = addresses.length ? addresses.map((a) => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--line);">
      <div>
        <strong style="font-size:13px;">${escapeHtml(a.name)}</strong>
        ${a.phone ? `<span class="muted" style="margin-left:6px;font-size:12px;">${escapeHtml(a.phone)}</span>` : ''}
        <p class="muted" style="font-size:12px;">${escapeHtml(a.address)}</p>
      </div>
      <div style="display:flex;gap:6px;">
        ${a.is_default ? '<span class="badge badge-brand" style="font-size:10px;">默认</span>' : ''}
        <button class="ghost-button" data-action="delete-address" data-id="${a.id}" type="button" style="font-size:11px;padding:2px 8px;color:#ef4444;">删除</button>
      </div>
    </div>
  `).join('') : '<p class="muted" style="font-size:12px;">暂无保存的地址。</p>';
}

function bindAddressEvents() {
  document.getElementById('address-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    try {
      await fetchJSON('/api/addresses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formData.get('name'),
          phone: formData.get('phone'),
          address: formData.get('address'),
          isDefault: formData.get('isDefault') === 'on'
        })
      });
      createToast('地址已保存。', 'success');
      form.reset();
      loadAddresses();
    } catch (error) {
      createToast(error.message, 'error');
    }
  });

  document.getElementById('address-list').addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-action="delete-address"]');
    if (!btn) return;
    try {
      await fetchJSON('/api/addresses/' + btn.dataset.id, { method: 'DELETE' });
      createToast('地址已删除。', 'success');
      loadAddresses();
    } catch (error) {
      createToast(error.message, 'error');
    }
  });
}

// ── 商品评价 ──

function bindProductReviewEvents() {
  document.getElementById('student-orders-list').addEventListener('click', async (event) => {
    const reviewBtn = event.target.closest('[data-action="review-product"]');
    if (!reviewBtn) return;
    const productId = reviewBtn.dataset.productId;
    const productTitle = reviewBtn.dataset.title;

    const overlay = document.createElement('div');
    overlay.className = 'celebration-overlay';
    overlay.innerHTML = `
      <div class="celebration-card" style="max-width:400px;">
        <h3 style="margin-bottom:12px;">评价商品：${escapeHtml(productTitle)}</h3>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;">
          <label style="font-size:13px;">评分：</label>
          <select id="product-review-rating" class="input" style="padding:6px 10px;font-size:13px;width:80px;">
            <option value="5">5星</option><option value="4">4星</option><option value="3">3星</option><option value="2">2星</option><option value="1">1星</option>
          </select>
        </div>
        <textarea class="textarea" id="product-review-content" placeholder="写下你的评价..." style="min-height:60px;"></textarea>
        <div style="display:flex;gap:8px;margin-top:12px;">
          <button class="button" id="submit-product-review" data-product-id="${productId}" type="button">提交评价</button>
          <button class="ghost-button" onclick="this.closest('.celebration-overlay').remove()" type="button">取消</button>
        </div>
      </div>
    `;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);

    document.getElementById('submit-product-review').addEventListener('click', async () => {
      const rating = Number(document.getElementById('product-review-rating').value);
      const content = document.getElementById('product-review-content').value.trim();
      try {
        await fetchJSON('/api/products/' + productId + '/reviews', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rating, content })
        });
        createToast('评价已提交。', 'success');
        overlay.remove();
      } catch (error) {
        createToast(error.message, 'error');
      }
    });
  });
}

// ── 商城推荐 & 拼团 ──

async function loadRecommendedProducts() {
  try {
    const res = await fetchJSON('/api/products/recommended');
    const container = document.getElementById('student-products-list');
    if (!container || !res.products.length) return;
    const recDiv = document.createElement('div');
    recDiv.className = 'paper-card';
    recDiv.style.marginBottom = '16px';
    recDiv.innerHTML = '<h4 style="margin:0 0 10px;color:var(--brand);">为你推荐</h4>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;">' +
      res.products.map((p) =>
        '<div style="border:1px solid var(--border);border-radius:10px;padding:10px;text-align:center;">' +
        '<div style="font-size:13px;font-weight:600;">' + escapeHtml(p.title) + '</div>' +
        '<div style="font-size:16px;font-weight:700;color:var(--brand);margin-top:6px;">¥' + p.price + '</div>' +
        (p.originalPrice > p.price ? '<div style="font-size:11px;text-decoration:line-through;color:var(--muted);">¥' + p.originalPrice + '</div>' : '') +
        '</div>'
      ).join('') + '</div>';
    container.insertBefore(recDiv, container.firstChild);
  } catch (_) {}
}

async function loadGroupBuys() {
  try {
    const res = await fetchJSON('/api/group-buys');
    const container = document.getElementById('student-store');
    if (!container || !res.groupBuys.length) return;
    let gbDiv = document.getElementById('group-buys-area');
    if (!gbDiv) {
      gbDiv = document.createElement('div');
      gbDiv.id = 'group-buys-area';
      gbDiv.style.cssText = 'margin-top:16px;padding:16px;border:1px solid var(--brand-light);border-radius:12px;background:#fefce8;';
      container.insertBefore(gbDiv, container.querySelector('#student-products-list'));
    }
    gbDiv.innerHTML = '<h4 style="margin:0 0 10px;color:#92400e;">限时拼团</h4>' +
      res.groupBuys.map((g) =>
        '<div style="display:flex;align-items:center;gap:12px;padding:10px;background:#fff;border-radius:8px;margin-bottom:8px;">' +
        '<div style="flex:1;"><div style="font-size:13px;font-weight:600;">' + escapeHtml(g.product_title) + '</div>' +
        '<div style="font-size:12px;color:#92400e;">拼团价 ¥' + g.groupPrice + ' · 已拼 ' + g.currentCount + '/' + g.targetCount + ' 人</div></div>' +
        '<button class="button" style="font-size:11px;padding:4px 12px;" data-action="join-group" data-id="' + g.id + '">参与拼团</button></div>'
      ).join('');
  } catch (_) {}
}

// ── 虚拟商品下载 ──

function bindVirtualGoods() {
  document.getElementById('student-store').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action="download-virtual"]');
    if (btn) {
      try {
        const res = await fetchJSON('/api/orders/' + btn.dataset.orderId + '/download');
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:2000;display:flex;align-items:center;justify-content:center;';
        overlay.innerHTML = '<div style="background:#fff;border-radius:16px;padding:30px;max-width:500px;width:90%;"><h3>虚拟商品内容</h3>' +
          '<div style="margin-top:12px;white-space:pre-wrap;font-size:13px;max-height:400px;overflow:auto;padding:12px;border:1px solid var(--border);border-radius:8px;">' + escapeHtml(res.content) + '</div>' +
          '<div style="text-align:center;margin-top:16px;"><button class="ghost-button" onclick="this.closest(\'div[style*=fixed]\').remove()">关闭</button></div></div>';
        overlay.addEventListener('click', (ev) => { if (ev.target === overlay) overlay.remove(); });
        document.body.appendChild(overlay);
      } catch (err) { createToast(err.message, 'error'); }
    }
    // 拼团参与
    const joinGroupBtn = e.target.closest('[data-action="join-group"]');
    if (joinGroupBtn) {
      try {
        const res = await fetchJSON('/api/group-buys/' + joinGroupBtn.dataset.id + '/join', { method: 'POST' });
        createToast('已参与拼团！当前 ' + res.currentCount + '/' + res.targetCount + ' 人。', 'success');
        loadGroupBuys();
      } catch (err) { createToast(err.message, 'error'); }
    }
    // 习惯打卡
    const checkHabitBtn = e.target.closest('[data-action="check-habit"]');
    if (checkHabitBtn) {
      try {
        await fetchJSON('/api/habits/' + checkHabitBtn.dataset.id + '/check', { method: 'POST' });
        loadHabits();
      } catch (err) { createToast(err.message, 'error'); }
    }
    // 删除习惯
    const deleteHabitBtn = e.target.closest('[data-action="delete-habit"]');
    if (deleteHabitBtn) {
      try {
        await fetchJSON('/api/habits/' + deleteHabitBtn.dataset.id, { method: 'DELETE' });
        loadHabits();
      } catch (err) { createToast(err.message, 'error'); }
    }
  });
}
