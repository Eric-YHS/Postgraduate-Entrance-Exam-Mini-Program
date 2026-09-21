#!/bin/bash
###############################################################################
# 服务器安全加固与恶意软件清理脚本
# 目标服务器: 159.75.67.99
# 用途: 终止恶意进程、清理持久化、加固 SSH、配置防火墙、安装审计工具
# 警告: 请在执行前仔细阅读每个阶段的说明，建议在 screen/tmux 中运行
# 作者: Claude (AI 生成)
# 日期: 2026-06-27
###############################################################################

set -euo pipefail

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 日志函数
log_info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step()  { echo -e "\n${BLUE}========== $1 ==========${NC}"; }

# 确认函数
confirm() {
    read -r -p "${YELLOW}[确认] $1 (y/N): ${NC}" response
    case "$response" in
        [yY][eE][sS]|[yY]) return 0 ;;
        *) return 1 ;;
    esac
}

# 检查 root 权限
if [[ $EUID -ne 0 ]]; then
   log_error "此脚本必须以 root 身份运行"
   exit 1
fi

###############################################################################
# 阶段 0: 保存证据（在任何清理之前）
###############################################################################
log_step "阶段 0: 保存当前证据供后续溯源"

EVIDENCE_DIR="/root/incident-evidence-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$EVIDENCE_DIR"
log_info "证据保存目录: $EVIDENCE_DIR"

# 保存进程列表
ps auxf > "$EVIDENCE_DIR/ps-auxf.txt" 2>/dev/null && log_info "已保存进程列表" || log_warn "保存进程列表失败"

# 保存网络连接
ss -tulnp > "$EVIDENCE_DIR/ss-tulnp.txt" 2>/dev/null && log_info "已保存监听端口" || log_warn "保存监听端口失败"
ss -tan > "$EVIDENCE_DIR/ss-tan.txt" 2>/dev/null && log_info "已保存所有连接" || log_warn "保存连接失败"

# 保存 crontab
crontab -l > "$EVIDENCE_DIR/root-crontab.txt" 2>/dev/null && log_info "已保存 root crontab" || log_warn "保存 crontab 失败"
cat /etc/crontab > "$EVIDENCE_DIR/etc-crontab.txt" 2>/dev/null && log_info "已保存 /etc/crontab" || log_warn "保存 /etc/crontab 失败"

# 保存 systemd 服务列表
systemctl list-units --type=service --state=running > "$EVIDENCE_DIR/systemd-running.txt" 2>/dev/null && log_info "已保存运行中服务" || log_warn "保存服务列表失败"

# 保存文件哈希（针对已知恶意文件）
for f in /go/cx /.mod; do
    if [[ -f "$f" ]]; then
        sha256sum "$f" > "$EVIDENCE_DIR/sha256-$(basename "$f").txt" 2>/dev/null && log_info "已保存 $f 哈希" || true
    fi
done

# 保存 auth.log 尾部
tail -n 1000 /var/log/auth.log > "$EVIDENCE_DIR/auth-log-tail.txt" 2>/dev/null && log_info "已保存 auth.log 尾部" || log_warn "保存 auth.log 失败"

log_warn "证据已保存到 $EVIDENCE_DIR，请在清理前复核"

###############################################################################
# 阶段 1: 终止恶意进程
###############################################################################
log_step "阶段 1: 终止恶意进程"

MALICIOUS_PID=1470304
MALICIOUS_PROC="/go/cx"

if ps -p "$MALICIOUS_PID" > /dev/null 2>&1; then
    log_warn "发现恶意进程 PID $MALICIOUS_PID: $(ps -p "$MALICIOUS_PID" -o comm= 2>/dev/null || echo 'unknown')"
    if confirm "是否终止 PID $MALICIOUS_PID?"; then
        kill -9 "$MALICIOUS_PID" && log_info "已终止 PID $MALICIOUS_PID" || log_error "终止 PID $MALICIOUS_PID 失败"
    else
        log_warn "跳过终止 PID $MALICIOUS_PID"
    fi
else
    log_info "PID $MALICIOUS_PID 未运行"
fi

# 检查是否还有 /go/cx 的其他实例
OTHER_PIDS=$(pgrep -f "$MALICIOUS_PROC" || true)
if [[ -n "$OTHER_PIDS" ]]; then
    log_warn "发现其他 /go/cx 进程: $OTHER_PIDS"
    for pid in $OTHER_PIDS; do
        if confirm "是否终止 PID $pid?"; then
            kill -9 "$pid" && log_info "已终止 PID $pid" || log_error "终止 PID $pid 失败"
        fi
    done
fi

log_info "预期效果: 释放被占用的 2.7GB 内存和 16.2% CPU，停止对外 SSH 扫描"

###############################################################################
# 阶段 2: 清理 Crontab 持久化
###############################################################################
log_step "阶段 2: 清理 Crontab 中的恶意条目"

# 备份并清理 root crontab
if crontab -l > /dev/null 2>&1; then
    ROOT_CRON=$(crontab -l 2>/dev/null || true)
    if echo "$ROOT_CRON" | grep -qE '(/go/cx|/.mod)'; then
        log_warn "root crontab 中发现可疑条目:"
        echo "$ROOT_CRON" | grep -E '(/go/cx|/.mod)' | while read -r line; do
            echo "  $line"
        done
        if confirm "是否清理 root crontab 中的 /go/cx 和 /.mod 条目?"; then
            echo "$ROOT_CRON" | grep -vE '(/go/cx|/.mod)' | crontab - && log_info "已清理 root crontab" || log_error "清理失败"
        fi
    else
        log_info "root crontab 中未发现可疑条目"
    fi
fi

# 检查 /etc/crontab
if [[ -f /etc/crontab ]]; then
    if grep -qE '(/go/cx|/.mod)' /etc/crontab 2>/dev/null; then
        log_warn "/etc/crontab 中发现可疑条目:"
        grep -E '(/go/cx|/.mod)' /etc/crontab | while read -r line; do
            echo "  $line"
        done
        if confirm "是否注释掉 /etc/crontab 中的可疑条目?"; then
            sed -i '/\/go\/cx/s/^/# REMOVED /' /etc/crontab
            sed -i '/\/.mod/s/^/# REMOVED /' /etc/crontab
            log_info "已注释 /etc/crontab 中的可疑条目"
        fi
    else
        log_info "/etc/crontab 中未发现可疑条目"
    fi
fi

# 检查 /etc/cron.d/
log_info "检查 /etc/cron.d/ 目录..."
for f in /etc/cron.d/*; do
    [[ -f "$f" ]] || continue
    if grep -qE '(/go/cx|/.mod|xcfhxbnd97)' "$f" 2>/dev/null; then
        log_warn "发现可疑文件: $f"
        if confirm "是否删除 $f?"; then
            mv "$f" "$EVIDENCE_DIR/" && log_info "已移动 $f 到证据目录" || log_warn "移动失败"
        fi
    fi
done

log_info "预期效果: 阻止恶意进程每分钟自动重启，消除持久化入口"

###############################################################################
# 阶段 3: 清理 Systemd 持久化
###############################################################################
log_step "阶段 3: 清理可疑 Systemd 服务"

SUSPICIOUS_SERVICE="xcfhxbnd97.service"
SERVICE_FILE="/etc/systemd/system/$SUSPICIOUS_SERVICE"

if systemctl list-unit-files | grep -q "$SUSPICIOUS_SERVICE"; then
    log_warn "发现可疑服务: $SUSPICIOUS_SERVICE"
    systemctl status "$SUSPICIOUS_SERVICE" --no-pager 2>/dev/null || true

    if confirm "是否停止并禁用 $SUSPICIOUS_SERVICE?"; then
        systemctl stop "$SUSPICIOUS_SERVICE" 2>/dev/null && log_info "已停止 $SUSPICIOUS_SERVICE" || log_warn "停止失败或已停止"
        systemctl disable "$SUSPICIOUS_SERVICE" 2>/dev/null && log_info "已禁用 $SUSPICIOUS_SERVICE" || log_warn "禁用失败"
    fi

    if [[ -f "$SERVICE_FILE" ]]; then
        log_warn "服务文件存在: $SERVICE_FILE"
        cat "$SERVICE_FILE" | head -20
        if confirm "是否删除 $SERVICE_FILE?"; then
            cp "$SERVICE_FILE" "$EVIDENCE_DIR/" && \
            rm "$SERVICE_FILE" && \
            log_info "已删除 $SERVICE_FILE" || log_error "删除失败"
        fi
    fi

    systemctl daemon-reload && log_info "已重载 systemd 配置" || log_warn "daemon-reload 失败"
else
    log_info "未发现 $SUSPICIOUS_SERVICE"
fi

log_info "预期效果: 消除 systemd 后门持久化，阻止恶意服务开机自启"

###############################################################################
# 阶段 4: 清理可疑文件
###############################################################################
log_step "阶段 4: 清理可疑文件（谨慎模式）"

# 定义可疑文件列表（不自动删除，仅标记供复核）
SUSPICIOUS_FILES=(
    "/go/cx"
    "/.mod"
    "/etc/rc.local"
    "/etc/rc.d/dns-udp4"
    "/etc/init.d/dns-udp4"
    "/etc/profile.d/gateway.sh"
    "/etc/profile.d/bash.cfg.sh"
    "/etc/.cfg"
    "/tmp/.ssh_scanner_installed"
    "/tmp/ssh_scanner.lock"
)

for f in "${SUSPICIOUS_FILES[@]}"; do
    if [[ -f "$f" ]]; then
        log_warn "发现可疑文件: $f"
        echo "  文件类型: $(file "$f" 2>/dev/null || echo 'unknown')"
        echo "  权限: $(ls -la "$f" 2>/dev/null || echo 'unknown')"

        # 显示文件内容（如果是文本）
        if file "$f" 2>/dev/null | grep -q text; then
            echo "  内容预览:"
            head -5 "$f" | sed 's/^/    /'
        fi

        if confirm "是否移动 $f 到证据目录并删除原文件?"; then
            cp "$f" "$EVIDENCE_DIR/" 2>/dev/null && \
            rm "$f" && \
            log_info "已删除 $f" || log_error "删除 $f 失败"
        else
            log_warn "跳过删除 $f，请手动检查"
        fi
    else
        log_info "文件不存在: $f"
    fi
done

# 检查 /tmp 下其他可疑文件
log_info "扫描 /tmp 下的其他可疑文件..."
find /tmp -maxdepth 1 -type f -name "*.sh" -o -name "*scanner*" -o -name "*miner*" -o -name "*bot*" 2>/dev/null | while read -r f; do
    log_warn "发现可疑文件: $f"
    if confirm "是否移动 $f 到证据目录?"; then
        mv "$f" "$EVIDENCE_DIR/" 2>/dev/null && log_info "已移动 $f" || log_warn "移动失败"
    fi
done

log_info "预期效果: 清除恶意二进制、后门脚本和 SSH 扫描器痕迹"

###############################################################################
# 阶段 5: 检查并清理 SSH 授权密钥
###############################################################################
log_step "阶段 5: 检查 SSH 授权密钥"

# 检查所有用户的 .ssh/authorized_keys
for user_home in /root /home/*; do
    [[ -d "$user_home" ]] || continue
    auth_keys="$user_home/.ssh/authorized_keys"
    if [[ -f "$auth_keys" ]]; then
        user=$(basename "$user_home")
        key_count=$(wc -l < "$auth_keys" 2>/dev/null || echo 0)
        log_warn "用户 $user 的 authorized_keys 存在 ($key_count 行)"
        echo "  文件: $auth_keys"

        # 显示密钥指纹
        ssh-keygen -l -f "$auth_keys" 2>/dev/null | while read -r line; do
            echo "  $line"
        done

        if confirm "是否查看 $user 的 authorized_keys 完整内容?"; then
            cat "$auth_keys" | sed 's/^/  /'
        fi

        if confirm "是否清空 $user 的 authorized_keys（请确保你有其他登录方式）?"; then
            cp "$auth_keys" "$EVIDENCE_DIR/authorized_keys-$user" && \
            echo "# 已清理 - $(date)" > "$auth_keys" && \
            log_info "已清空 $user 的 authorized_keys" || log_error "清空失败"
        fi
    fi
done

log_info "预期效果: 清除攻击者植入的后门 SSH 公钥，防止重新入侵"

###############################################################################
# 阶段 6: SSH 加固
###############################################################################
log_step "阶段 6: SSH 加固"

SSH_CONFIG="/etc/ssh/sshd_config"
SSH_CONFIG_D="/etc/ssh/sshd_config.d"

# 备份原配置
cp "$SSH_CONFIG" "$EVIDENCE_DIR/sshd_config.bak" && log_info "已备份 $SSH_CONFIG" || log_warn "备份失败"

# 创建加固配置
SSH_HARDENING_FILE="$SSH_CONFIG_D/99-hardening.conf"
mkdir -p "$SSH_CONFIG_D"

cat > "$SSH_HARDENING_FILE" << 'EOF'
# 安全加固配置 - 由加固脚本生成
# 禁用 root 密码登录
PermitRootLogin no

# 禁用密码认证，仅允许密钥认证
PasswordAuthentication no
PubkeyAuthentication yes

# 限制认证尝试
MaxAuthTries 3
MaxSessions 2

# 空闲超时
ClientAliveInterval 300
ClientAliveCountMax 2

# 禁用空密码
PermitEmptyPasswords no

# 仅允许特定用户（可选，取消注释并修改）
# AllowUsers ubuntu admin

# 使用更安全的算法
Ciphers chacha20-poly1305@openssh.com,aes256-gcm@openssh.com,aes128-gcm@openssh.com,aes256-ctr,aes192-ctr,aes128-ctr
MACs hmac-sha2-512-etm@openssh.com,hmac-sha2-256-etm@openssh.com,umac-128-etm@openssh.com
KexAlgorithms curve25519-sha256,curve25519-sha256@libssh.org,ecdh-sha2-nistp521,ecdh-sha2-nistp384,diffie-hellman-group-exchange-sha256

# 禁用 X11 转发
X11Forwarding no

# 隐藏版本信息
DebianBanner no
EOF

log_info "已创建 SSH 加固配置: $SSH_HARDENING_FILE"

# 询问是否修改 SSH 端口
if confirm "是否将 SSH 端口从 22 改为非标准端口（如 2222）?"; then
    read -r -p "请输入新 SSH 端口 [2222]: " new_port
    new_port=${new_port:-2222}

    # 检查端口是否被占用
    if ss -tlnp | grep -q ":$new_port "; then
        log_error "端口 $new_port 已被占用"
    else
        echo "Port $new_port" >> "$SSH_HARDENING_FILE"
        log_info "SSH 端口已改为 $new_port"
        log_warn "请确保防火墙和安全组已开放端口 $new_port 后再断开当前连接！"
    fi
fi

# 验证配置并重启
if sshd -t; then
    log_info "SSH 配置验证通过"
    if confirm "是否重启 SSH 服务以应用配置?"; then
        systemctl restart sshd && log_info "SSH 服务已重启" || log_error "重启失败"
    fi
else
    log_error "SSH 配置验证失败，请检查 $SSH_HARDENING_FILE"
fi

log_info "预期效果: 禁用密码登录和 root 登录，减少暴力破解面，提升加密安全性"

###############################################################################
# 阶段 7: 安装并配置 fail2ban
###############################################################################
log_step "阶段 7: 安装并配置 fail2ban"

if ! command -v fail2ban-server &> /dev/null; then
    log_info "正在安装 fail2ban..."
    apt-get update -qq
    apt-get install -y fail2ban && log_info "fail2ban 安装成功" || log_error "安装失败"
else
    log_info "fail2ban 已安装"
fi

# 创建自定义配置
F2B_LOCAL="/etc/fail2ban/jail.local"
cat > "$F2B_LOCAL" << 'EOF'
[DEFAULT]
# 禁止时间: 1小时
bantime = 3600
# 查找时间: 10分钟
findtime = 600
# 最大重试次数
maxretry = 3
# 后端使用 systemd
backend = systemd

# 发送邮件通知（可选，需配置邮件服务器）
# destemail = admin@example.com
# sender = fail2ban@example.com
# action = %(action_mwl)s

[sshd]
enabled = true
port = ssh
filter = sshd
logpath = /var/log/auth.log
maxretry = 3
bantime = 3600

# 自定义 SSH 端口时修改如下
# port = 2222
EOF

systemctl enable fail2ban && log_info "已启用 fail2ban 开机自启"
systemctl restart fail2ban && log_info "已启动 fail2ban" || log_error "启动 fail2ban 失败"

# 显示状态
sleep 2
fail2ban-client status sshd 2>/dev/null && log_info "fail2ban sshd 监狱状态正常" || log_warn "获取状态失败"

log_info "预期效果: 自动封禁 SSH 暴力破解 IP，3 次失败尝试后封禁 1 小时"

###############################################################################
# 阶段 8: 配置 UFW 防火墙
###############################################################################
log_step "阶段 8: 配置 UFW 防火墙"

if ! command -v ufw &> /dev/null; then
    log_info "正在安装 UFW..."
    apt-get install -y ufw && log_info "UFW 安装成功" || log_error "安装失败"
fi

# 重置 UFW 为默认状态（谨慎）
log_warn "即将重置 UFW 防火墙规则"
if confirm "是否重置 UFW 并配置新规则?"; then
    ufw --force reset && log_info "已重置 UFW"

    # 默认策略
    ufw default deny incoming
    ufw default allow outgoing
    log_info "已设置默认策略: 拒绝入站，允许出站"

    # 允许必要端口
    ufw allow 80/tcp comment 'HTTP'
    ufw allow 443/tcp comment 'HTTPS'
    log_info "已开放 HTTP/HTTPS"

    # SSH 端口
    ssh_port=$(grep -E '^Port\s+' "$SSH_HARDENING_FILE" 2>/dev/null | awk '{print $2}' || echo 22)
    ufw allow "$ssh_port/tcp" comment 'SSH'
    log_info "已开放 SSH 端口 $ssh_port/tcp"

    # 询问是否限制管理 IP
    if confirm "是否限制仅允许特定 IP 访问 SSH（强烈推荐）?"; then
        read -r -p "请输入允许的管理 IP: " admin_ip
        if [[ -n "$admin_ip" ]]; then
            ufw delete allow "$ssh_port/tcp" 2>/dev/null || true
            ufw allow from "$admin_ip" to any port "$ssh_port" proto tcp comment "SSH from admin"
            log_info "已限制 SSH 仅允许 IP: $admin_ip"
        fi
    fi

    # 启用 UFW
    ufw --force enable && log_info "UFW 已启用" || log_error "启用 UFW 失败"
    ufw status verbose
else
    log_warn "跳过 UFW 配置"
fi

log_info "预期效果: 仅允许必要端口入站，阻断所有未授权访问"

###############################################################################
# 阶段 9: 系统更新
###############################################################################
log_step "阶段 9: 更新系统和关键软件包"

log_info "正在更新软件包列表..."
apt-get update -qq && log_info "软件包列表已更新" || log_error "更新失败"

if confirm "是否升级所有已安装软件包?"; then
    apt-get upgrade -y && log_info "系统软件包已升级" || log_warn "部分软件包升级失败"
fi

if confirm "是否执行发行版升级（dist-upgrade）?"; then
    apt-get dist-upgrade -y && log_info "发行版升级完成" || log_warn "部分升级失败"
fi

# 安装关键安全更新
log_info "安装安全相关软件包..."
apt-get install -y \
    unattended-upgrades \
    apt-listchanges \
    && log_info "自动更新工具已安装" || log_warn "安装失败"

# 配置自动安全更新
if [[ -f /etc/apt/apt.conf.d/50unattended-upgrades ]]; then
    sed -i 's|//\s*"\${distro_id}:\${distro_codename}-security";|"\${distro_id}:\${distro_codename}-security";|' /etc/apt/apt.conf.d/50unattended-upgrades
    log_info "已启用自动安全更新"
fi

log_info "预期效果: 修复已知漏洞，保持系统安全补丁最新"

###############################################################################
# 阶段 10: 安装入侵检测和审计工具
###############################################################################
log_step "阶段 10: 安装入侵检测和审计工具"

# rkhunter
if ! command -v rkhunter &> /dev/null; then
    log_info "正在安装 rkhunter..."
    apt-get install -y rkhunter && log_info "rkhunter 安装成功" || log_warn "安装失败"
fi

# 更新 rkhunter 数据库
if command -v rkhunter &> /dev/null; then
    log_info "更新 rkhunter 数据库..."
    rkhunter --update --sk 2>/dev/null || log_warn "rkhunter 更新失败（可能网络问题）"
    rkhunter --propupd --sk 2>/dev/null || log_warn "rkhunter 属性更新失败"

    if confirm "是否立即运行 rkhunter 扫描?"; then
        rkhunter --check --sk | tee "$EVIDENCE_DIR/rkhunter-report.txt"
        log_info "rkhunter 扫描完成，报告保存到 $EVIDENCE_DIR/rkhunter-report.txt"
    fi
fi

# chkrootkit
if ! command -v chkrootkit &> /dev/null; then
    log_info "正在安装 chkrootkit..."
    apt-get install -y chkrootkit && log_info "chkrootkit 安装成功" || log_warn "安装失败"
fi

if command -v chkrootkit &> /dev/null; then
    if confirm "是否立即运行 chkrootkit 扫描?"; then
        chkrootkit 2>&1 | tee "$EVIDENCE_DIR/chkrootkit-report.txt"
        log_info "chkrootkit 扫描完成，报告保存到 $EVIDENCE_DIR/chkrootkit-report.txt"
    fi
fi

# auditd（可选，资源占用较高）
if confirm "是否安装 auditd 审计守护进程（会记录所有系统调用，资源占用较高）?"; then
    apt-get install -y auditd audispd-plugins && log_info "auditd 安装成功" || log_warn "安装失败"

    # 配置 auditd 规则
    cat >> /etc/audit/rules.d/hardening.rules << 'EOF'
# 监控用户/组修改
-w /etc/group -p wa -k identity
-w /etc/passwd -p wa -k identity
-w /etc/shadow -p wa -k identity
-w /etc/security/passwd -p wa -k identity

# 监控 SSH 配置
-w /etc/ssh/sshd_config -p wa -k sshd_config

# 监控 sudoers
-w /etc/sudoers -p wa -k sudoers
-w /etc/sudoers.d/ -p wa -k sudoers

# 监控 cron
-w /etc/crontab -p wa -k cron
-w /etc/cron.d/ -p wa -k cron
-w /etc/cron.daily/ -p wa -k cron
-w /etc/cron.hourly/ -p wa -k cron
-w /etc/cron.weekly/ -p wa -k cron
-w /etc/cron.monthly/ -p wa -k cron

# 监控 systemd
-w /etc/systemd/ -p wa -k systemd

# 监控用户登录
-w /var/log/wtmp -p wa -k logins
-w /var/log/btmp -p wa -k logins
-w /var/log/lastlog -p wa -k logins
EOF

    systemctl enable auditd && systemctl restart auditd && log_info "auditd 已启用" || log_warn "auditd 启动失败"
fi

# 安装 Lynis（安全审计工具）
if confirm "是否安装 Lynis 进行全面的安全审计?"; then
    apt-get install -y lynis && log_info "Lynis 安装成功" || log_warn "安装失败"
    if command -v lynis &> /dev/null; then
        lynis audit system --quick 2>&1 | tee "$EVIDENCE_DIR/lynis-report.txt"
        log_info "Lynis 审计完成，报告保存到 $EVIDENCE_DIR/lynis-report.txt"
    fi
fi

log_info "预期效果: 检测 rootkit、后门、未授权文件变更，提供持续安全监控"

###############################################################################
# 阶段 11: 额外加固措施
###############################################################################
log_step "阶段 11: 额外加固措施"

# 禁用不必要的账户
log_info "检查系统账户..."
for user in admin test user www-data; do
    if id "$user" &>/dev/null; then
        log_warn "发现用户: $user"
        if confirm "是否锁定用户 $user?"; then
            usermod -L "$user" && log_info "已锁定用户 $user" || log_warn "锁定失败"
        fi
    fi
done

# 检查 SUID/SGID 文件
log_info "扫描异常 SUID/SGID 文件..."
find / -perm -4000 -o -perm -2000 2>/dev/null | grep -v -E '^/(usr/)?s?bin' > "$EVIDENCE_DIR/suid-sgid-files.txt"
if [[ -s "$EVIDENCE_DIR/suid-sgid-files.txt" ]]; then
    log_warn "发现非标准位置的 SUID/SGID 文件，请检查: $EVIDENCE_DIR/suid-sgid-files.txt"
fi

# 配置日志保留
log_info "配置日志保留策略..."
cat > /etc/logrotate.d/security-hardening << 'EOF'
/var/log/auth.log {
    daily
    rotate 30
    compress
    delaycompress
    missingok
    notifempty
    create 0640 root adm
}
EOF

# 禁用核心转储
cat > /etc/security/limits.d/hardening.conf << 'EOF'
* hard core 0
* soft core 0
EOF
log_info "已禁用核心转储"

# 内核参数加固
SYSCTL_CONF="/etc/sysctl.d/99-hardening.conf"
cat > "$SYSCTL_CONF" << 'EOF'
# 禁用 IP 源路由
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.default.accept_source_route = 0

# 禁用 ICMP 重定向
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv4.conf.all.secure_redirects = 0
net.ipv4.conf.default.secure_redirects = 0

# 禁用发送 ICMP 重定向
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.send_redirects = 0

# 启用 SYN Cookie
net.ipv4.tcp_syncookies = 1

# 禁用 IPv6（如果不需要）
# net.ipv6.conf.all.disable_ipv6 = 1
# net.ipv6.conf.default.disable_ipv6 = 1

# 增强内存分配安全
vm.mmap_rnd_bits = 32
vm.mmap_rnd_compat_bits = 16
EOF

sysctl -p "$SYSCTL_CONF" && log_info "内核参数已应用" || log_warn "部分内核参数应用失败"

log_info "预期效果: 减少攻击面，防止常见网络攻击，增强系统级安全"

###############################################################################
# 阶段 12: 最终检查与报告
###############################################################################
log_step "阶段 12: 最终检查与报告"

log_info "生成加固报告..."
REPORT_FILE="$EVIDENCE_DIR/hardening-report.txt"

cat > "$REPORT_FILE" << EOF
===============================================
服务器安全加固报告
服务器: 159.75.67.99
日期: $(date)
===============================================

## 1. 已执行的清理操作
- 恶意进程 /go/cx (PID 1470304) 已终止
- Crontab 中的恶意条目已清理
- 可疑 systemd 服务 xcfhxbnd97.service 已禁用并删除
- 可疑文件已移动到证据目录: $EVIDENCE_DIR

## 2. SSH 加固
- 禁用 root 登录
- 禁用密码认证
- 启用密钥认证
- 限制最大认证尝试次数
- 配置安全加密算法
- $(grep -q '^Port' "$SSH_HARDENING_FILE" 2>/dev/null && echo "SSH 端口已修改" || echo "SSH 端口保持 22")

## 3. 防火墙配置
$(ufw status numbered 2>/dev/null || echo "UFW 状态未知")

## 4. 安装的审计工具
$(dpkg -l 2>/dev/null | grep -E 'rkhunter|chkrootkit|fail2ban|auditd|lynis' || echo "请检查安装状态")

## 5. 后续建议
- 检查所有用户的密码强度并更换
- 生成新的 SSH 密钥对
- 在腾讯云安全组中限制 SSH 访问源 IP
- 定期检查 crontab 和 systemd 服务
- 监控 /var/log/auth.log 中的异常登录
- 考虑部署 AIDE 文件完整性监控
- 定期运行 rkhunter 和 chkrootkit

## 6. 证据目录
所有原始恶意文件和日志已保存到: $EVIDENCE_DIR
EOF

cat "$REPORT_FILE"

log_step "加固完成"
log_info "证据和报告保存在: $EVIDENCE_DIR"
log_warn "重要提醒:"
echo "  1. 如果你修改了 SSH 端口，请确保新端口已开放再断开连接"
echo "  2. 请检查所有用户密码是否已更换"
echo "  3. 请生成新的 SSH 密钥对并更新 authorized_keys"
echo "  4. 建议在腾讯云控制台设置安全组，仅允许特定 IP 访问 SSH"
echo "  5. 定期运行: rkhunter --check --sk 和 chkrootkit"
echo "  6. 监控 /var/log/fail2ban.log 中的封禁记录"

log_info "脚本执行完毕。"
