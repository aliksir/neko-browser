import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 新規テストは test/ 配下（既存の tests/ は node --test ベースのため対象外）
    include: ['test/**/*.test.ts'],
    // Playwrightのブラウザ起動・操作を含むため、デフォルトより長めに設定
    testTimeout: 15000,
    hookTimeout: 30000,
  },
});
