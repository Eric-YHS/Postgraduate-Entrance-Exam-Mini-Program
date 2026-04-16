const { request, resolveUrl } = require('../../utils/request');
const { ensureLogin } = require('../../utils/auth');

Page({
  data: {
    loading: true,
    activeTab: 'products',
    // 商品
    products: [],
    // 购物车
    cartItems: [],
    cartCount: 0,
    // 订单
    orders: [],
    // 地址
    addresses: [],
    selectedAddressId: null,
    // 新地址表单
    showAddressForm: false,
    newAddress: { name: '', phone: '', address: '', isDefault: false }
  },

  onShow() {
    if (!ensureLogin()) return;
    this.loadProducts();
    this.loadCart();
    this.loadOrders();
    this.loadAddresses();
  },

  onPullDownRefresh() {
    Promise.all([
      this.loadProducts(),
      this.loadCart(),
      this.loadOrders(),
      this.loadAddresses()
    ]).finally(() => wx.stopPullDownRefresh());
  },

  async loadProducts() {
    try {
      const app = getApp();
      const payload = await app.fetchBootstrap();
      this.setData({
        loading: false,
        products: (payload.products || []).map(p => ({
          ...p,
          imageUrl: resolveUrl(p.imagePath)
        }))
      });
    } catch (error) {
      this.setData({ loading: false });
      wx.showToast({ title: error.message, icon: 'none' });
    }
  },

  async loadCart() {
    try {
      const data = await request({ url: '/api/cart' });
      const cartItems = (data.items || []).map(item => ({
        ...item,
        imageUrl: resolveUrl(item.image_path)
      }));
      this.setData({
        cartItems,
        cartCount: cartItems.reduce((sum, i) => sum + i.quantity, 0)
      });
    } catch (e) {
      // 静默处理
    }
  },

  async loadOrders() {
    try {
      const app = getApp();
      const payload = await app.fetchBootstrap();
      this.setData({ orders: payload.orders || [] });
    } catch (e) {
      // 静默处理
    }
  },

  async loadAddresses() {
    try {
      const data = await request({ url: '/api/addresses' });
      const addresses = data.addresses || [];
      const defaultAddr = addresses.find(a => a.is_default);
      this.setData({
        addresses,
        selectedAddressId: defaultAddr ? defaultAddr.id : (addresses[0] ? addresses[0].id : null)
      });
    } catch (e) {
      // 静默处理
    }
  },

  // Tab 切换
  switchTab(e) {
    this.setData({ activeTab: e.currentTarget.dataset.tab });
  },

  // 加入购物车
  async addToCart(e) {
    const productId = e.currentTarget.dataset.id;
    try {
      await request({
        url: '/api/cart',
        method: 'POST',
        data: { productId, quantity: 1 }
      });
      wx.showToast({ title: '已加入购物车', icon: 'success' });
      this.loadCart();
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' });
    }
  },

  // 删除购物车项
  async removeCartItem(e) {
    const cartItemId = e.currentTarget.dataset.id;
    wx.showModal({
      title: '删除确认',
      content: '确定要从购物车中移除这件商品吗？',
      confirmText: '删除',
      confirmColor: '#dc2626',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await request({
            url: `/api/cart/${cartItemId}`,
            method: 'DELETE'
          });
          this.loadCart();
        } catch (error) {
          wx.showToast({ title: error.message, icon: 'none' });
        }
      }
    });
  },

  // 选择地址
  selectAddress(e) {
    this.setData({ selectedAddressId: e.currentTarget.dataset.id });
  },

  // 显示/隐藏地址表单
  toggleAddressForm() {
    this.setData({ showAddressForm: !this.data.showAddressForm });
  },

  handleAddressFormInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`newAddress.${field}`]: e.detail.value });
  },

  toggleDefaultAddress() {
    this.setData({ 'newAddress.isDefault': !this.data.newAddress.isDefault });
  },

  async saveAddress() {
    const { name, phone, address } = this.data.newAddress;
    if (!name.trim() || !address.trim()) {
      wx.showToast({ title: '请填写姓名和地址', icon: 'none' });
      return;
    }
    try {
      await request({
        url: '/api/addresses',
        method: 'POST',
        data: {
          name: name.trim(),
          phone: phone.trim(),
          address: address.trim(),
          isDefault: this.data.newAddress.isDefault
        }
      });
      wx.showToast({ title: '地址已保存', icon: 'success' });
      this.setData({
        showAddressForm: false,
        newAddress: { name: '', phone: '', address: '', isDefault: false }
      });
      this.loadAddresses();
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' });
    }
  },

  // 购物车结账
  async checkout() {
    if (!this.data.selectedAddressId) {
      wx.showToast({ title: '请选择收货地址', icon: 'none' });
      return;
    }
    try {
      const result = await request({
        url: '/api/cart/checkout',
        method: 'POST',
        data: { addressId: this.data.selectedAddressId }
      });
      wx.showToast({ title: `下单成功，共${result.created}件`, icon: 'success' });
      this.loadCart();
      this.loadOrders();
      this.setData({ activeTab: 'orders' });
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' });
    }
  },

  // 订单状态文本
  getStatusText(status) {
    const map = { paid: '已支付', shipped: '已发货', delivered: '已送达', cancelled: '已取消' };
    return map[status] || status;
  },

  getStatusColor(status) {
    const map = { paid: '#2563eb', shipped: '#ea580c', delivered: '#16a34a', cancelled: '#6b7280' };
    return map[status] || '#6b7280';
  }
});
