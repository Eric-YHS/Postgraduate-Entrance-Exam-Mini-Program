# GitHub Actions 自动部署配置指南

你需要到 GitHub 仓库的 **Settings → Secrets and variables → Actions** 页面，点击 **"New repository secret"** 按钮，依次添加 3 个密钥。

---

## 第 1 个密钥：SERVER_HOST

填写内容：

| 字段   | 值              |
| ------ | --------------- |
| Name   | `SERVER_HOST`   |
| Secret | `159.75.67.99`  |

填写完成后点击绿色按钮 **"Add secret"** 保存。

---

## 第 2 个密钥：SERVER_USER

再次点击 **"New repository secret"**，填写内容：

| 字段   | 值            |
| ------ | ------------- |
| Name   | `SERVER_USER` |
| Secret | `ubuntu`      |

填写完成后点击 **"Add secret"** 保存。

---

## 第 3 个密钥：SERVER_SSH_KEY

再次点击 **"New repository secret"**，填写内容：

| 字段   | 值               |
| ------ | ---------------- |
| Name   | `SERVER_SSH_KEY` |
| Secret | 见下方私钥内容    |

Secret 栏粘贴服务器上生成的**完整私钥内容**（包括首尾两行），格式如下：

```
-----BEGIN OPENSSH PRIVATE KEY-----
<粘贴你的私钥内容>
-----END OPENSSH PRIVATE KEY-----
```

> **注意**：私钥内容在服务器上通过 `cat ~/.ssh/id_ed25519` 获取，不要泄露给任何人。

填写完成后点击 **"Add secret"** 保存。

---

## 配置完成后的效果

3 个密钥全部添加后，页面应该显示如下：

```
SERVER_HOST       (Updated just now)
SERVER_SSH_KEY    (Updated just now)
SERVER_USER       (Updated just now)
```

之后每次你执行 `git push` 到 `main` 分支，GitHub 就会自动：
1. 通过 SSH 连接到你的服务器
2. 拉取最新代码
3. 安装依赖
4. 用 PM2 重启服务

你可以在仓库的 **Actions** 标签页查看每次自动部署的运行状态。

---

## 测试自动部署

配置完成后，可以用以下命令测试：

```bash
git commit --allow-empty -m "test: trigger auto deploy"
git push origin main
```

然后到 GitHub 仓库的 **Actions** 标签页，应该能看到一个新的部署任务正在运行。
