'use strict';

import logger from '../../../services/loggerService';
import { APP_ROUTE_RENDERERS } from './routeRenderers';

export default function AppScreenRouter(props) {
  const renderRoute = APP_ROUTE_RENDERERS[props.currentScreen] || APP_ROUTE_RENDERERS.Login;
  return renderRoute({ ...props, logger });
}
