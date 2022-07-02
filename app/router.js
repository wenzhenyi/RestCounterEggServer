'use strict';

/**
 * @param {Egg.Application} app - egg application
 */
module.exports = app => {
  const { router, controller } = app;
  router.get('/', controller.home.index);
  router.get('/api/getUser', controller.api.getUser);
  router.post('/api/uploadFile', controller.api.uploadFile);
  router.post('/api/computeData', controller.api.computeData);
  router.get('/api/getLPR', controller.api.getLPR);
};
