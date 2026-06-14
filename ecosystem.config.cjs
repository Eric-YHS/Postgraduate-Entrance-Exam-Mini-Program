const path = require('path');
const rootDir = __dirname;

module.exports = {
  apps: [
    {
      name: 'study-planner',
      script: path.join(rootDir, 'src', 'server.js'),
      instances: 1,
      exec_mode: 'fork',
      env_file: path.join(rootDir, '.env'),
      env: {
        NODE_ENV: 'development',
        PORT: 3000
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000
      }
    }
  ]
};
