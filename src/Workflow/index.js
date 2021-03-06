import Queue from '../Queue';
import QueueDB from './QueueDB';
import getRoutes from './routes';
import Task from "./Task";
import logger from 'winston';
import _ from 'lodash';
import { getAppTypeKey, getIndexKey, getIndexPrefix, validateFirebaseKey } from "./utils";
import { WFSTATUS_INDEX_KEYNAME, APP_JOBTYPE_KEYNAME } from "./constants";
import firebaseAdmin from 'firebase-admin';

export default class WorkFlow {
  static initialized = false;
  static appQueues = {};

  constructor(options) {
    let { app, type = '', tasks = [], inputData, eventHandlers = {}, timeout, retries, numWorkers } = options;
    if (!WorkFlow.initialized) {
      throw new Error('Initialize class before creating new instances')
    }
    if (typeof app !== 'string' || app.length === 0) {
      throw new Error('Please provide a valid app');
    }
    if (typeof type !== 'string' || type.length === 0) {
      throw new Error('Please provide a job type');
    }
    if (tasks.length === 0) {
      tasks = [{
        id: type,
      }];
    }
    if (!Array.isArray(tasks)) {
      tasks = [tasks];
    }
    this.type = type;
    this.app = app;
    this.inputData = inputData;
    this.eventHandlers = eventHandlers;
    this.tasks = Task.createTasks(this.app, this.type, tasks, {
      timeout,
      retries,
      numWorkers,
    });
    this.startTask = this.tasks[tasks[0].id];
    const initHandler = eventHandlers.init;
    if (typeof initHandler === 'function') {
      setImmediate(initHandler, QueueDB.getTasksRef(app, type));
    }
  }

  static initialize({ firebase }) {
    try {
      QueueDB.initialize({
        ...firebase,
        firebaseInstance: firebaseAdmin,
      });
      WorkFlow.initialized = true;
      return QueueDB;
    } catch (ex) {
      throw ex;
    }
  }

  static getJobRoutes(apps, wares) {
    if (!WorkFlow.initialized) {
      throw new Error('Not initialized. Call static function `initialize` with firebase config.');
    }
    return getRoutes(apps, QueueDB, wares);
  }

  static shutdown(app) {
    if (!app) {
      throw new Error("Missing 'app' parameter");
    }
    const appQueues = WorkFlow.appQueues[app] || [];
    if (appQueues.length > 0) {
      const promises = appQueues.map(queue => queue.shutdown());
      Promise.all(promises)
        .then(res => logger.info(`${appQueues.length} queues shut down for app ${app}`))
        .catch(err => logger.error(err));
    } else {
      logger.info('No queues to shut down');
    }
  }

  on(taskName, handler) {
    const task = this.tasks[taskName];
    if (!task) {
      throw new Error(`'${taskName}' is not a registered task for this job.`);
    }
    let appQueues = WorkFlow.appQueues[this.app];
    if (!appQueues) {
      appQueues = [];
    }
    appQueues.push(new Queue({
      tasksRef: QueueDB.getTasksRef(this.app, this.type),
      specsRef: QueueDB.getSpecsRef(this.app, this.type)
    }, {
      specId: task.getId(),
      numWorkers: task.getWorkerCount(),
    }, task.getHandler(handler)));
    WorkFlow.appQueues[this.app] = appQueues;
  }

  getInputData(jobData) {
    if (typeof this.inputData === 'function') {
      return {
        input: this.inputData(jobData),
      };
    } else {
      return {};
    }
  }

  static setupStatusListener(taskRef, handler) {
    const listener = taskRef.child('__wfstatus__').on('value', wfSnap => {
      const wfStatus = wfSnap.val();
      taskRef.once('value')
        .then(jobSnap => setImmediate(handler, wfStatus, jobSnap.val()));
      if (wfStatus === -1 || wfStatus === 10) {
        taskRef.child('__wfstatus__').off('value', listener);
      }
    });
  }

  getFilteredTasks(query) {
    return QueueDB.getFilteredTasksRef({
      app: this.app,
      jobType: this.type,
      ...query,
    });
  }

  getJobData(taskKey) {
    return QueueDB.getTaskRef(this.app, this.type, taskKey)
      .once('value')
      .then(taskSnap => taskSnap.val());
  }

  add(jobData, { indexField, indexId, eventHandlers = {} } = {}) {
    const statusChangeHandler = this.eventHandlers['status'] || eventHandlers['status'];
    const wfStatus = 0;
    const userid = jobData.user || 'anonymous_user';
    const user = validateFirebaseKey(userid);
    const taskData = {
      ...jobData,
      user,
      userid,
      __type__: this.type,
      __app__: this.app,
      __display__: this.getInputData(jobData),
      _state: this.startTask.getStartState(),
      __wfstatus__: wfStatus,
    };
    if (!_.isUndefined(indexId) || !_.isUndefined(indexField)) {
      taskData.__index__ = getIndexPrefix(indexId, indexField);
      taskData[WFSTATUS_INDEX_KEYNAME] = getIndexKey(user, wfStatus, indexId, indexField);
    }
    const taskRef = QueueDB.getTasksRef(this.app, this.type).push(taskData);
    delete taskData._state;
    delete taskData.__wfstatus__;
    delete taskData[WFSTATUS_INDEX_KEYNAME];
    delete taskData.user;
    const allTasksRef = QueueDB.getAllTasksRef(user).push({
      ...taskData,
      [APP_JOBTYPE_KEYNAME]: getAppTypeKey(this.app, this.type),
      __ref__: taskRef.key,
    });
    if (statusChangeHandler) {
      WorkFlow.setupStatusListener(taskRef, statusChangeHandler);
    }
    return taskRef
      .then(() => ({
        id: taskRef.key,
        key: allTasksRef.key,
        ref: taskRef,
      }));
  }
}