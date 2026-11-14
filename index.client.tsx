import type { PluginClientContext } from '@getpaseo/plugin/client';
import { routes, Shell, Sidebar } from './client/shell';
import { Fleet } from './client/fleet';

export default function contribute(client: PluginClientContext) {
  const removers = routes.map(route => client.addScreen({
    id: route, title: route[0].toUpperCase() + route.slice(1),
    Component: props => route === 'fleet'
      ? <Fleet {...props} openScreen={input => client.openScreen(input)} />
      : <Shell {...props} route={route} openScreen={input => client.openScreen(input)} />,
  }));
  removers.push(client.addSidebarHeaderItem({ id: 'orbi', title: 'Orbi', Component: Sidebar }));
  return () => { for (const remove of removers) remove(); };
}
