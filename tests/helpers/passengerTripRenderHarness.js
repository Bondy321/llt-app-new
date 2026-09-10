const React = require('react');
const TestRenderer = require('react-test-renderer');

const { act } = TestRenderer;

const extractText = (children) => {
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(extractText).join('');
  return '';
};

const getRenderedText = (renderer) => renderer.root
  .findAll((node) => node.type === 'Text')
  .map((node) => extractText(node.props.children))
  .filter(Boolean);

const renderConsumer = async (Component, props) => {
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(Component, props));
  });
  return {
    renderer,
    text: () => getRenderedText(renderer),
    update: async (nextProps) => act(async () => {
      renderer.update(React.createElement(Component, nextProps));
    }),
    unmount: async () => act(async () => renderer.unmount()),
  };
};

module.exports = {
  getRenderedText,
  renderPassengerTripHome: (TourHomeScreen, props) => renderConsumer(TourHomeScreen, props),
  renderPassengerTripItinerary: (ItineraryScreen, props) => renderConsumer(ItineraryScreen, props),
};
