@echo off
chcp 65001 >nul
title TS4 Mod Manager - Build

echo ============================================================
echo   TS4 Mod Manager - Gerador de Executavel
echo ============================================================
echo.

:: Verificar Node.js
where node >nul 2>&1
if errorlevel 1 (
    echo [ERRO] Node.js nao encontrado!
    echo Instale em: https://nodejs.org/
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('node --version') do set NODE_VER=%%v
echo [OK] Node.js encontrado: %NODE_VER%

:: Verificar npm
where npm >nul 2>&1
if errorlevel 1 (
    echo [ERRO] npm nao encontrado!
    pause
    exit /b 1
)

echo.
echo [1/3] Instalando dependencias...
echo.
npm install
if errorlevel 1 (
    echo [ERRO] Falha ao instalar dependencias!
    pause
    exit /b 1
)

echo.
echo [2/3] Gerando instalador Windows...
echo.
npx electron-builder --win nsis --publish never
if errorlevel 1 (
    echo Tentando modo portable...
    npx electron-builder --win portable --publish never
)

echo.
if exist "dist\" (
    echo [3/3] Concluido! Arquivos gerados em:
    echo.
    dir /b dist\*.exe 2>nul && (
        for %%f in (dist\*.exe) do echo   -> %%f
        echo.
        echo Abrindo pasta dist...
        explorer dist
    ) || (
        echo [AVISO] Nenhum .exe encontrado em dist\
        echo Verifique os logs acima.
    )
) else (
    echo [ERRO] Pasta dist nao foi criada.
)

echo.
pause
