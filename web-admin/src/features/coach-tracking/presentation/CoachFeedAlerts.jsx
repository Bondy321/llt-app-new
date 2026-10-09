import { Alert, Button } from '@mantine/core';

export default function CoachFeedAlerts({ feed, demo, loading, prepared, invalidRows }) {
  return <>
    {demo ? <Alert color="orange" title="Demonstration mode · sample locations" role="status">
      These are fictional tours and drivers for presentation purposes. Positions are examples, not real coach movements. Nothing here changes the live tracking data.
    </Alert> : null}
    {!demo && feed.error ? <Alert color="red" title="Tracking feed unavailable" role="alert">{feed.error} <Button size="compact-sm" variant="subtle" color="red" onClick={feed.retry}>Retry tracking feed</Button></Alert> : null}
    {!demo && !loading && !feed.error && !prepared ? <Alert color="blue" title="Live tracking setup is pending" role="status">
      {feed.status?.state === 'building' ? 'The fleet feed is being prepared. The current results may be incomplete.'
        : feed.status?.state === 'error' ? 'Fleet preparation did not complete. The live view requires an operations setup check.'
          : 'The live fleet feed has not been prepared yet. Use the labelled demo to preview the workspace.'}
    </Alert> : null}
    {!demo && feed.loaded && !feed.connected && !feed.error ? <Alert color="orange" title="Connection lost · cached positions" role="status">
      Updates are paused. The coach may have moved; cached positions are not labelled Live. Reconnection is automatic.
    </Alert> : null}
    {!demo && feed.loaded && !feed.complete && !feed.error ? <Alert color="orange" title={feed.capped ? 'Fleet coverage is incomplete' : 'Loading the rest of the fleet'} role="status">
      {feed.capped ? `This view reached its safety limit of ${feed.limit?.toLocaleString()} tours. It does not represent the complete fleet. Contact operations support.`
        : 'More tour records are being loaded. Counts and markers are provisional until this finishes.'}
    </Alert> : null}
    {invalidRows > 0 ? <Alert color="orange" title="Some tour records could not be displayed" role="status">
      {invalidRows} tracking records are malformed. Fleet coverage is incomplete until these records are repaired.
    </Alert> : null}
  </>;
}
