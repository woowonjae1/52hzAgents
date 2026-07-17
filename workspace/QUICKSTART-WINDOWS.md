# OpenAgents Workspace on Windows

## Native development path (recommended while coding)

This uses Docker only for PostgreSQL, so frontend edits use Next.js hot reload
and backend changes do not require image builds.

```powershell
cd D:\code\52hzAgent\openagents-develop
.\workspace\dev.ps1
```

Open the workspace at http://localhost:3000. Stop local app processes with:

```powershell
.\workspace\stop-dev.ps1
```

## Docker Desktop path (integration / release verification)

Docker Desktop must report `Engine running` before the commands below can work.
If Docker reports that virtualization was not detected, enable Intel VT-x or
AMD SVM in BIOS/UEFI. When Windows itself runs inside CubeSandbox or another
virtual machine, nested virtualization must be enabled by the host.

From PowerShell:

```powershell
cd D:\code\52hzAgent\openagents-develop\workspace
docker compose up --build
```

Open the workspace at http://localhost:3000 and check the backend at
http://localhost:8000/api/health.

Stop the stack with:

```powershell
docker compose down
```

## Manual native development path

Install Go 1.21+, Node.js 20+, and PostgreSQL 16. Start PostgreSQL with a
database named `openagents_workspace`, user `postgres`, and password `dev`.
Then use two PowerShell windows:

```powershell
cd D:\code\52hzAgent\openagents-develop\workspace\backend
$env:DATABASE_URL = "postgresql://postgres:dev@localhost:5432/openagents_workspace"
go run .\cmd\server
```

```powershell
cd D:\code\52hzAgent\openagents-develop\workspace\frontend
npm ci
$env:NEXT_PUBLIC_API_URL = "http://localhost:8000"
npm run dev
```

The native frontend uses http://localhost:3001. The production/Compose
frontend uses http://localhost:3000.

## Build the Go `agn` client

```powershell
cd D:\code\52hzAgent\openagents-develop\packages\agn_go
go test ./...
go build -o agn.exe .
.\agn.exe version
```

To invoke it from any PowerShell window, add this directory to your user PATH,
or copy `agn.exe` to a directory already in PATH.
