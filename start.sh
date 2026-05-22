#!/bin/bash
# 云打印服务器启动脚本
echo "==============================="
echo "  睦邻云印 - 中转服务器"
echo "==============================="

cd "$(dirname "$0")"

# 检查 Node.js
if ! command -v node &> /dev/null; then
    echo "错误: 未安装 Node.js，请先安装 Node.js 16+"
    exit 1
fi

# 安装依赖
if [ ! -d "node_modules" ]; then
    echo "正在安装依赖..."
    npm install
fi

# 启动
echo "启动服务器..."
node server.js
