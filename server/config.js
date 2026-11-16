'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const DEFAULTS = {
  brand: '跨境 AI 工作台',
  brandEn: 'Ecom Workbench',
  tagline: '',
  port: 7861,
  apiBase: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  maxSteps: 10,
  version: '1.0.0',
};

function loadConfig() {
  let user = {};
  const file = path.join(ROOT, 'config.json');
  try {
    user = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[config] config.json 读取失败，使用默认配置：' + err.message);
    }
  }
  const cfg = { ...DEFAULTS, ...user };
  if (process.env.ECOM_API_BASE) cfg.apiBase = process.env.ECOM_API_BASE;
  if (process.env.ECOM_PORT) cfg.port = Number(process.env.ECOM_PORT) || cfg.port;
  if (process.env.ECOM_MODEL) cfg.model = process.env.ECOM_MODEL;
  cfg.port = Number.isFinite(Number(cfg.port)) ? Number(cfg.port) : DEFAULTS.port;
  cfg.apiBase = String(cfg.apiBase || DEFAULTS.apiBase).replace(/\/+$/, '');
  cfg.maxSteps = Math.max(1, Math.min(30, Number(cfg.maxSteps) || DEFAULTS.maxSteps));
  cfg.root = ROOT;
  return cfg;
}

module.exports = { ROOT, loadConfig };
