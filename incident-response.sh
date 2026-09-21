#!/bin/bash
set -euo pipefail

EVIDENCE_DIR="/root/incident-evidence-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$EVIDENCE_DIR"
echo "[INFO] 证据目录: $EVIDENCE_DIR"

# 保存证据
ps auxf > "$EVIDENCE_DIR/ps-auxf.txt" 2>/dev/null || true
ss -tan > "$EVIDENCE_DIR/ss-tan.txt" 2>/dev/null || true
ss -tulnp > "$EVIDENCE_DIR/ss-tulnp.txt" 2>/dev/null || true
crontab -l > "$EVIDENCE_DIR/root-crontab.txt" 2>/dev/null || true
cat /etc/crontab > "$EVIDENCE_DIR/etc-crontab.txt" 2>/dev/null || true
systemctl list-units --type=service --state=running --no-pager > "$EVIDENCE_DIR/systemd-running.txt" 2>/dev/null || true
systemctl status 7fjx5q344z.service --no-pager > "$EVIDENCE_DIR/7fjx5q344z-status.txt" 2>/dev/null || true
systemctl cat 7fjx5q344z.service > "$EVIDENCE_DIR/7fjx5q344z-cat.txt" 2>/dev/null || true
tail -n 2000 /var/log/auth.log > "$EVIDENCE_DIR/auth-log-tail.txt" 2>/dev/null || true
last -n 50 > "$EVIDENCE_DIR/last-logins.txt" 2>/dev/null || true

# 保存可疑文件哈希
for f in /go/cx /go/ali.txt /.mod /usr/lib/libgdi.so.0.8.2 /usr/bin/aaa /usr/bin/aa0 /boot/system.pub /etc/.cfg /etc/rc.local /etc/init.d/dns-udp4 /etc/rc.d/dns-udp4 /etc/systemd/system/7fjx5q344z.service; do
    if [[ -f "$f" ]]; then
        sha256sum "$f" >> "$EVIDENCE_DIR/sha256sums.txt" 2>/dev/null || true
        cp -a "$f" "$EVIDENCE_DIR/" 2>/dev/null || true
    fi
done

# 保存 authorized_keys
for user_home in /root /home/*; do
    [[ -d "$user_home" ]] || continue
    auth_keys="$user_home/.ssh/authorized_keys"
    if [[ -f "$auth_keys" ]]; then
        user=$(basename "$user_home")
        cp "$auth_keys" "$EVIDENCE_DIR/authorized_keys-$user" 2>/dev/null || true
    fi
done

echo "[INFO] 证据保存完成"

# 停止恶意服务
echo "[INFO] 停止并禁用 7fjx5q344z.service..."
systemctl stop 7fjx5q344z.service 2>/dev/null || true
systemctl disable 7fjx5q344z.service 2>/dev/null || true

# 终止恶意进程
echo "[INFO] 终止 /go/cx 相关进程..."
pkill -9 -f "/go/cx" 2>/dev/null || true
pkill -9 -f "libgdi.so" 2>/dev/null || true
pkill -9 -f "/usr/bin/aa0" 2>/dev/null || true
pkill -9 -f "/usr/bin/aaa" 2>/dev/null || true
pkill -9 -f "/boot/system.pub" 2>/dev/null || true

# 清理 root crontab
echo "[INFO] 清理 root crontab 恶意条目..."
if crontab -l 2>/dev/null | grep -qE '(/go/cx|/.mod|libgdi|system\.pub)'; then
    crontab -l 2>/dev/null | grep -vE '(/go/cx|/.mod|libgdi|system\.pub)' | crontab -
    echo "[INFO] root crontab 已清理"
fi

# 修复 /etc/rc.local
echo "[INFO] 修复 /etc/rc.local..."
cat > /etc/rc.local << 'EOF'
#!/bin/bash
/usr/local/qcloud/irq/net_smp_affinity.sh >/tmp/net_affinity.log 2>&1
/usr/local/qcloud/cpuidle/cpuidle_support.sh &> /tmp/cpuidle_support.log
/usr/local/qcloud/rps/set_rps.sh >/tmp/setRps.log 2>&1
/usr/local/qcloud/xps/set_xps.sh &> /tmp/set_xps.log &
/usr/local/qcloud/irq/virtio_blk_smp_affinity.sh > /tmp/virtio_blk_affinity.log 2>&1
/usr/local/qcloud/gpu/nv_gpu_conf.sh >/tmp/nv_gpu_conf.log 2>&1
/usr/local/qcloud/scripts/disable_rt_runtime_share.sh >/tmp/disable_rt_runtime_share.log 2>&1
EOF
chmod +x /etc/rc.local

# 删除恶意文件
echo "[INFO] 删除恶意文件..."
rm -f /go/cx
rm -f /go/ali.txt
rm -rf /go
rm -f /.mod
rm -f /usr/lib/libgdi.so.0.8.2
rm -f /usr/bin/aaa
rm -f /usr/bin/aa0
rm -f /boot/system.pub
rm -f /etc/.cfg
rm -f /etc/init.d/dns-udp4
rm -f /etc/rc.d/dns-udp4
rm -f /etc/systemd/system/7fjx5q344z.service
rm -f /tmp/ssh_scanner.lock

# 删除 systemd 残留链接
rm -f /etc/systemd/system/multi-user.target.wants/7fjx5q344z.service 2>/dev/null || true

systemctl daemon-reload 2>/dev/null || true
systemctl reset-failed 2>/dev/null || true

echo "[INFO] 清理完成，证据保存在: $EVIDENCE_DIR"
