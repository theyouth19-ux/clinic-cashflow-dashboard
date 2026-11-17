@echo off
chcp 65001 >nul
title 피부과 의원 PC 자동수집 & 손익 대시보드 서버
cd /d "%~dp0"
echo ====================================================================
echo  🏥 피부과 의원 PC 자동 수집 로봇 및 대시보드 서버를 시작합니다...
echo  - PC 열람 주소: http://127.0.0.1:3080
echo  - 갤럭시 폴드5 열람 주소: https://theyouth19-ux.github.io/clinic-cashflow-dashboard/
echo  - 스마트 자동수집 폴더: %~dp0data\inbox
echo ====================================================================
start "" "http://127.0.0.1:3080"
node server.js
pause
