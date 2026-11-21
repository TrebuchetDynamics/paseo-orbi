import type { PluginClientContext } from '@getpaseo/plugin/client';
import { routeTitle, routes, Shell, Sidebar } from './client/shell';

export default function contribute(client: PluginClientContext) {
  const removers = routes.map(route => client.addScreen({
    id: route, title: routeTitle(route),
    Component: props => <Shell {...props} route={route} openScreen={input => client.openScreen(input)} />,
  }));
  removers.push(client.addSidebarHeaderItem({ id: 'orbi', title: 'Orbi', Component: Sidebar }));
  return () => { for (const remove of removers) remove(); };
}
