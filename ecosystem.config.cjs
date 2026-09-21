const path = require('path');
const fs = require('fs');
const rootDir = __dirname;
const productionNode = '/home/ubuntu/.nvm/versions/node/v22.22.3/bin/node';
const nodeInterpreter = process.env.PM2_NODE_INTERPRETER
  || (fs.existsSync(productionNode) ? productionNode : 'node');

module.exports = {
  apps: [
    {
      name: 'study-planner',
      script: path.join(rootDir, 'src', 'server.js'),
      interpreter: nodeInterpreter,
      instances: 1,
      exec_mode: 'fork',
      env_file: path.join(rootDir, '.env'),
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
        FREE_ACCESS_MODE: 'true'
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
        FREE_ACCESS_MODE: 'true'
      }
    }
  ]
};
