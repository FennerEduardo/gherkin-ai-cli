import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { isCoreLayerFile, pickAsyncApiFile, handleValidateCommand } from '../../src/commands/validate';

describe('validate helpers', () => {
  it('checks prohibited imports only in domain and application code', () => {
    expect(isCoreLayerFile('src/domain/order.aggregate.ts')).toBe(true);
    expect(isCoreLayerFile('src/application/place-order.handler.ts')).toBe(true);
    expect(isCoreLayerFile('src/infrastructure/prisma/order.repository.ts')).toBe(false);
    expect(isCoreLayerFile('src/presentation/orders.controller.ts')).toBe(false);
    expect(isCoreLayerFile('src/main.ts')).toBe(false);
    expect(isCoreLayerFile('src/app.module.ts')).toBe(false);
    expect(isCoreLayerFile('src/domain/orders.module.ts')).toBe(false);
  });

  it('picks the AsyncAPI document of the feature, then the root one', () => {
    const root = path.join('out');
    const files = [path.join(root, 'asyncapi.json'), path.join(root, 'contracts', 'place-order', 'asyncapi.json')];
    expect(pickAsyncApiFile(files, root, 'specs/place-order.feature')).toBe(files[1]);
    expect(pickAsyncApiFile(files, root, 'specs/refunds.feature')).toBe(files[0]);
    expect(pickAsyncApiFile(files, root)).toBe(files[0]);
  });
});

describe('ghk validate', () => {
  let dir: string;
  let cwd: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-validate-'));
    cwd = process.cwd();
    process.chdir(dir);
    process.exitCode = undefined;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.chdir(cwd);
    process.exitCode = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  };

  it('passes a NestJS layout whose framework imports stay at the edges', async () => {
    write('gherkin-ai.config.json', JSON.stringify({ architecture: 'hexagonal', outputDir: './', stack: { language: 'typescript', framework: 'nestjs', orm: 'prisma' } }));
    write('src/domain/order.ts', 'export class Order {}\n');
    write('src/infrastructure/order.repository.ts', "import { PrismaClient } from 'prisma';\nexport const r = PrismaClient;\n");
    write('src/presentation/orders.controller.ts', "import { Controller } from '@nestjs/common';\nexport const c = Controller;\n");
    write('src/main.ts', "import { NestFactory } from '@nestjs/core';\nimport express from 'express';\nexport { NestFactory, express };\n");
    write('node_modules/x/domain/index.ts', "import express from 'express';\nexport default express;\n");

    await handleValidateCommand({});
    expect(process.exitCode).toBeUndefined();
  });

  it('still flags a framework import inside the domain', async () => {
    write('gherkin-ai.config.json', JSON.stringify({ architecture: 'hexagonal', outputDir: './', stack: { language: 'typescript', framework: 'nestjs', orm: 'prisma' } }));
    write('src/domain/order.ts', "import { Injectable } from '@nestjs/common';\nexport const i = Injectable;\n");

    await handleValidateCommand({ target: '.' });
    expect(process.exitCode).toBe(4);
  });
});
