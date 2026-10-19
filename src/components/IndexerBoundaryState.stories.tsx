import type { Meta, StoryObj } from '@storybook/react-vite';
import { IndexerBoundaryState } from './IndexerBoundaryState';
import type { IndexerBoundaryStatus } from '@/lib/indexer-boundary';

const meta = {
  title: 'Components/IndexerBoundaryState',
  component: IndexerBoundaryState,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    status: {
      control: 'select',
      options: ['loading', 'stale', 'empty', 'unauthorized', 'malformed', 'unavailable', 'rate-limited'],
    },
    detail: { control: 'text' },
    onRetry: { action: 'retry' },
  },
} satisfies Meta<typeof IndexerBoundaryState>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Loading — the fetch is in flight. */
export const Loading: Story = {
  args: { status: 'loading' satisfies IndexerBoundaryStatus },
};

/** Stale — live data is unavailable, last-good data is shown instead. */
export const Stale: Story = {
  args: {
    status: 'stale' satisfies IndexerBoundaryStatus,
    detail: 'Last updated 2 minutes ago',
  },
};

/** Empty — the request succeeded but returned no rows. */
export const Empty: Story = {
  args: { status: 'empty' satisfies IndexerBoundaryStatus },
};

/** Unauthorized — the caller is not permitted to read this data. */
export const Unauthorized: Story = {
  args: { status: 'unauthorized' satisfies IndexerBoundaryStatus },
};

/** Malformed — the response could not be parsed into the expected shape. */
export const Malformed: Story = {
  args: { status: 'malformed' satisfies IndexerBoundaryStatus },
};

/** Unavailable — indexer service cannot be reached. */
export const Unavailable: Story = {
  args: { status: 'unavailable' satisfies IndexerBoundaryStatus },
};

/** RateLimited — indexer rate limit reached. */
export const RateLimited: Story = {
  args: { status: 'rate-limited' satisfies IndexerBoundaryStatus },
};

/** Loading with a retry affordance (recoverable boundary). */
export const WithRetry: Story = {
  args: { status: 'malformed' satisfies IndexerBoundaryStatus, onRetry: () => {} },
};
