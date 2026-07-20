#!/usr/bin/env node
'use strict';

const [major] = process.versions.node.split('.').map(Number);
if (major < 18) {
  process.stderr.write(
    `cc-proxy requires Node.js 18 or newer (found ${process.versions.node}).\n` +
      `Please upgrade Node: https://nodejs.org/\n`,
  );
  process.exit(1);
}

require('../lib/proxy.js');
