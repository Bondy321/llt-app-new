import { registerDriverTrackingTask } from './driverTrackingRuntime';

// Eager module-scope registration is required for headless native delivery.
registerDriverTrackingTask();
