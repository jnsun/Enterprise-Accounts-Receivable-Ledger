/**
 * auth.js - 认证模块（登录 / 登出 / 会话 / 权限）
 * 复用月报系统的账号体系：auth.users + profiles + departments
 * 登录标识符支持：邮箱 / 手机号 / 部门名称 / 部门编码（RPC resolve_login_identifier）
 */

const Auth = {

  currentUser: null,
  currentProfile: null,
  /** 台账用户记录（ar_users 表，独立于月报 profiles） */
  arUser: null,
  /** 当前用户权限对象 { view: true, ... }；管理员为全部 true */
  perms: {},
  isAdmin: false,
  /** 台账超级管理员（独立于月报系统） */
  isSuperAdmin: false,

  /** 初始化会话：已登录返回 {user, profile}，否则 null */
  async init() {
    const result = await sb.auth.getSession();
    const session = result && result.data ? result.data.session : null;
    if (!session) return null;

    this.currentUser = session.user;
    const { profile, error } = await this.fetchProfile();
    if (error || !profile) return null;
    this.currentProfile = profile;
    await this.loadPerms();
    return { user: this.currentUser, profile: this.currentProfile };
  },

  /** 获取 profile（含部门信息） */
  async fetchProfile() {
    if (!this.currentUser) return { profile: null, error: '未获取到当前用户' };
    const { data, error } = await sb
      .from('profiles')
      .select('*, departments(*)')
      .eq('id', this.currentUser.id)
      .single();
    if (error) return { profile: null, error: error.message };
    return { profile: data, error: null };
  },

  /** 加载当前用户权限（台账用户存于独立 ar_users 表，与月报系统隔离） */
  async loadPerms() {
    const { data: arUser } = await sb.from('ar_users')
      .select('*, departments(name)')
      .eq('user_id', this.currentUser.id)
      .maybeSingle();
    this.arUser = arUser || null;
    this.isSuperAdmin = !!(arUser && arUser.ar_super_admin === true);
    this.isAdmin = !!(arUser && (arUser.ar_role === 'admin' || this.isSuperAdmin));
    this.perms = {};
    if (this.isAdmin) {
      PERM_DEFS.forEach(p => { this.perms[p.key] = true; });
      return;
    }
    const { data, error } = await sb
      .from('ar_user_perms')
      .select('perms')
      .eq('user_id', this.currentUser.id)
      .maybeSingle();
    if (!error && data && data.perms) {
      PERM_DEFS.forEach(p => {
        if (data.perms[p.key] === true) this.perms[p.key] = true;
      });
    }
    // 部门用户默认必有"查看本部门"权限基线（未开放任何权限则仅可登录）
    if (!Object.keys(this.perms).length) this.perms = {};
  },

  can(key) {
    if (this.isAdmin) return true;
    return this.perms[key] === true;
  },

  /** 权限数量（左侧权限栏展示用） */
  permCount() {
    return PERM_DEFS.filter(p => this.can(p.key)).length;
  },

  /**
   * 登录（邮箱 / 手机号 / 部门名称 / 部门编码）
   */
  async login(identifier, password) {
    let email;
    const id = String(identifier || '').trim();
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(id)) {
      email = id.toLowerCase();
    } else {
      // 手机号 / 部门名称 / 部门编码 -> 复用月报系统 RPC 解析
      const { data, error } = await sb.rpc('resolve_login_identifier', { p_identifier: id });
      if (error) {
        return { success: false, error: '未找到对应的登录账号，请使用完整邮箱登录' };
      }
      if (data && data.email) email = data.email;
    }
    if (!email) return { success: false, error: '未找到对应的登录账号' };

    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) return { success: false, error: this.mapAuthError(error.message) };

    this.currentUser = data.user;
    const { profile, error: profileError } = await this.fetchProfile();
    if (profileError || !profile) {
      return { success: false, error: '用户信息获取失败，请联系管理员。' };
    }
    this.currentProfile = profile;
    await this.loadPerms();
    return { success: true };
  },

  mapAuthError(msg) {
    const m = String(msg || '');
    if (m.includes('Invalid login credentials')) return '账号或密码错误';
    if (m.includes('Email not confirmed')) return '账号尚未激活，请联系管理员';
    if (m.includes('Too many requests')) return '尝试次数过多，请稍后再试';
    return m || '登录失败';
  },

  async changePassword(newPassword) {
    const pwd = String(newPassword || '');
    if (pwd.length < 6) return { success: false, error: '新密码长度至少 6 位' };
    const { error } = await sb.auth.updateUser({ password: pwd });
    if (error) return { success: false, error: error.message };
    return { success: true };
  },

  async logout() {
    await sb.auth.signOut();
    this.currentUser = null;
    this.currentProfile = null;
    this.perms = {};
    this.isAdmin = false;
    this.isSuperAdmin = false;
    this.arUser = null;
  },
};
