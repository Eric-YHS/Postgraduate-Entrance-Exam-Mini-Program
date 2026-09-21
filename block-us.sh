#!/bin/bash
# Block all US IP ranges using nftables
set -euo pipefail

US_ZONE="/tmp/us.zone"
NFT_CONF="/etc/nftables.conf"

# Create/flush a set for US IPs
sudo nft add table ip filter 2>/dev/null || true
sudo nft delete set ip filter us_block 2>/dev/null || true
sudo nft add set ip filter us_block { type ipv4_addr\; flags interval\; auto-merge \; }

# Build list for nft
cidrs=()
while IFS= read -r cidr; do
    [ -z "$cidr" ] && continue
    cidrs+=("$cidr")
done < "$US_ZONE"

total=${#cidrs[@]}
echo "Total US CIDRs: $total"

# Add in batches of 1000
batch_size=1000
for (( i=0; i<total; i+=batch_size )); do
    end=$(( i + batch_size ))
    if (( end > total )); then end=$total; fi
    batch=""
    for (( j=i; j<end; j++ )); do
        if [ -z "$batch" ]; then
            batch="${cidrs[j]}"
        else
            batch="$batch, ${cidrs[j]}"
        fi
    done
    echo "Adding entries $i to $end"
    sudo nft add element ip filter us_block { $batch }
done

# Add drop rule (try YJ-FIREWALL-INPUT first, fall back to INPUT)
if sudo nft list chain ip filter YJ-FIREWALL-INPUT >/dev/null 2>&1; then
    echo "Adding drop rule to YJ-FIREWALL-INPUT"
    sudo nft add rule ip filter YJ-FIREWALL-INPUT ip saddr @us_block counter drop
else
    echo "Adding drop rule to INPUT"
    sudo nft insert rule ip filter INPUT ip saddr @us_block counter drop
fi

# Make persistent
sudo nft list ruleset > "$NFT_CONF"
echo "US IP ranges blocked"
