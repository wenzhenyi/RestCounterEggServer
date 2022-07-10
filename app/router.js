'use strict';

/**
 * @param {Egg.Application} app - egg application
 */
module.exports = app => {
  const { router, controller } = app;
  router.get('/', controller.home.index);
  router.get('/api/getUser', controller.api.getUser);
  router.post('/api/uploadFile', controller.api.uploadFile);
  // 计算
  router.post('/api/computeData', controller.api.computeData);
  // 获取lpr数据
  router.get('/api/getLPR', controller.api.getLPR);
  // 更新lpr
  router.post('/api/uploadLPR', controller.api.uploadLPR);
  // 下载模板文件
  router.get('/api/downloadTemplate', controller.api.downloadTemplate);
};
