module.exports = {
  apps: [
    {
      name: 'screen-record-poc',
      script: './server.js',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      ignore_watch: [
        'node_modules',
        'uploads',
        'logs',
        '.git'
      ],
      env: {
        NODE_ENV: 'development',
        PORT: 8089
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 8000
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      merge_logs: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '5s'
    }
  ]
};
