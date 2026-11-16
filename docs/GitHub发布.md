# 用 GitHub 分发和跨电脑更新

目标：代码放在 GitHub，别人从 **Releases** 下载 zip 到桌面；你在任何一台电脑上 `git pull` 继续改，打标签后 GitHub Actions 自动出新的发布包。

---

## 0. 仓库里不放什么

`.gitignore` 已经排除：

- `runtime/node.exe`（92MB 二进制，首次打包时自动下载）
- `data/`（对话、附件、`mcp.json` 里的 Key）
- `workspace/`（生成的文件）
- `dist/`、`_dist/`（打包产物）
- `docs/*.png`（截图，不随源码提交）

所以仓库很小，只有源码、技能、文档和测试。

---

## 1. 第一次推到 GitHub

在 GitHub 上新建一个空仓库，例如 `ecom-workbench`（不要勾选 README / .gitignore），然后在本机执行：

```powershell
cd D:\deepseek相关\马修\ecom-workbench
git remote add origin https://github.com/bfsu1666935342-pixel/ecom-workbench.git
git branch -M main
git push -u origin main
```

> 这个目录里已经初始化好 git 并做了首次提交；只差 remote 和 push。
> 如果还没登录 GitHub，先在 Git Credential Manager 里登录，或用 SSH remote。

---

## 2. 发一个新版本

改完代码后：

1. 改 `config.json` 的 `version`（例如 `1.2.2`）。
2. 改 `README.md` 顶部的版本号和底部版本。
3. 提交、打标签、推送：

```powershell
git add .
git commit -m "v1.2.2"
git tag v1.2.2
git push origin main --tags
```

GitHub Actions（`.github/workflows/release.yml`）会自动：

1. 下载 Node 运行时到 `runtime/node.exe`；
2. 跑 Markdown / 工具沙箱 / MCP 单元测试；
3. 执行 `打包.ps1` 生成 `dist/EcomWorkbench-v1.2.2.zip` 和 `SHA256.txt`；
4. 创建 GitHub Release，把 zip 和校验文件挂上去。

发布成功后，别人下载：

```text
https://github.com/bfsu1666935342-pixel/ecom-workbench/releases/latest
```

解压 → 双击 `Start.bat` → 填自己的 Key。

---

## 3. 在另一台电脑上继续改

```powershell
git clone https://github.com/bfsu1666935342-pixel/ecom-workbench.git
cd ecom-workbench

# 有 Node 22+：直接开发
dev.bat

# 没有 Node，或要出分发包：自动下载 runtime
powershell -ExecutionPolicy Bypass -File .\scripts\prepare-runtime.ps1
powershell -ExecutionPolicy Bypass -File .\打包.ps1
```

以后更新：

```powershell
git pull
```

`data/` 和 `workspace/` 不会进 Git；换电脑想保留对话，手动复制这两个文件夹。

---

## 4. 常见问题

**GitHub Actions 里下载 Node 很慢/失败**
`prepare-runtime.ps1` 默认从 `nodejs.org` 下载。如果 CI 网络不稳，可以改成公司镜像，或把 `node.exe` 放进一个私有 Release 再下载。

**不想让 GitHub 构建，想手动发**
在本机跑 `打包.ps1`，把 `dist/EcomWorkbench-v*.zip` 和 `SHA256.txt` 手动拖到 Release 里即可。

**用户下载后打不开**
确认是 Windows 10/11、解压后再运行、没有被杀软拦截 `runtime/node.exe`。

**公司/学校网络访问不了 GitHub**
可以用 Gitee 镜像，或者把 Release 的 zip 传到网盘/对象存储；工作台本身不需要访问 GitHub 才能运行。
