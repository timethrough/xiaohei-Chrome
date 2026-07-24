import { rcedit } from 'rcedit';

const [exePath, iconPath] = process.argv.slice(2);
if (!exePath || !iconPath) {
  throw new Error('Usage: node brand-exe.mjs <exePath> <iconPath>');
}

await rcedit(exePath, {
  'version-string': {
    ProductName: '小黑多开器',
    FileDescription: '小黑多开器',
    CompanyName: '小黑多开器开源项目',
    LegalCopyright: 'AGPL-3.0-or-later',
    OriginalFilename: '小黑多开器.exe'
  },
  'file-version': '15.0.0.0',
  'product-version': '15.0.0.0',
  icon: iconPath,
  'requested-execution-level': 'asInvoker'
});