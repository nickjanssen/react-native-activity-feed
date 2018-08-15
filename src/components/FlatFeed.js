// @flow
import * as React from 'react';
import { FlatList, RefreshControl } from 'react-native';
import immutable from 'immutable';
import URL from 'url-parse';

import { StreamContext } from '../Context';
import { buildStylesheet } from '../styles';

import type {
  NavigationProps,
  ChildrenProps,
  StylesProps,
  ReactElementCreator,
  BaseActivityResponse,
  BaseAppCtx,
  BaseUserSession,
  ReactComponentFunction,
} from '../types';
import type {
  FeedRequestOptions,
  FeedResponse,
  StreamFeed,
  ReactionRequestOptions,
} from 'getstream';

type Props = {|
  feedGroup: string,
  userId?: string,
  options?: FeedRequestOptions,
  renderActivity?: ReactComponentFunction,
  ActivityComponent?: ReactElementCreator,
  BelowListComponent?: any,
  doFeedRequest?: (
    session: BaseUserSession,
    feedGroup: string,
    userId?: string,
    options?: FeedRequestOptions,
  ) => Promise<FeedResponse<{}, {}>>,
  noPagination?: boolean,
  analyticsLocation?: string,
  ...NavigationProps,
  ...ChildrenProps,
  ...StylesProps,
|};

export default class FlatFeed extends React.Component<Props> {
  static defaultProps = {
    styles: {},
  };

  render = function() {
    return (
      <StreamContext.Consumer>
        {(appCtx) => <FlatFeedInner {...this.props} {...appCtx} />}
      </StreamContext.Consumer>
    );
  };
}

type PropsInner = {| ...Props, ...BaseAppCtx |};
type State = {
  activityOrder: Array<string>,
  activities: any,
  refreshing: boolean,
  lastResponse: ?FeedResponse<{}, {}>,
};

class FlatFeedInner extends React.Component<PropsInner, State> {
  constructor(props: PropsInner) {
    super(props);
    this.state = {
      activityOrder: [],
      activities: immutable.Map(),
      lastResponse: null,
      refreshing: false,
    };
  }

  _trackAnalytics = (
    label: string,
    activity: BaseActivityResponse,
    track: ?boolean,
  ) => {
    let analyticsClient = this.props.analyticsClient;

    if (!track || !analyticsClient) {
      return;
    }

    let feed = this.props.session.feed(this.props.feedGroup, this.props.userId);

    analyticsClient.trackEngagement({
      label: label,
      feed_id: feed.id,
      content: {
        foreign_id: activity.foreign_id,
      },
      location: this.props.analyticsLocation,
    });
  };

  _onAddReaction = async (
    kind: string,
    activity: BaseActivityResponse,
    options: { trackAnalytics?: boolean } & ReactionRequestOptions<{}> = {},
  ) => {
    let reaction = await this.props.session.react(kind, activity, options);
    this._trackAnalytics(kind, activity, options.trackAnalytics);
    let enrichedReaction = immutable.fromJS({
      ...reaction,
      user: this.props.user.full,
    });

    return this.setState((prevState) => {
      let activities = prevState.activities
        .updateIn([activity.id, 'reaction_counts', kind], (v = 0) => v + 1)
        .updateIn(
          [activity.id, 'own_reactions', kind],
          (v = immutable.List()) => v.unshift(enrichedReaction),
        )
        .updateIn(
          [activity.id, 'latest_reactions', kind],
          (v = immutable.List()) => v.unshift(enrichedReaction),
        );

      return { activities };
    });
  };

  _onRemoveReaction = async (
    kind: string,
    activity: BaseActivityResponse,
    id: string,
    options: { trackAnalytics?: boolean } = {},
  ) => {
    await this.props.session.reactions.delete(id);
    this._trackAnalytics('un' + kind, activity, options.trackAnalytics);

    return this.setState((prevState) => {
      let activities = prevState.activities
        .updateIn([activity.id, 'reaction_counts', kind], (v = 0) => v - 1)
        .updateIn(
          [activity.id, 'own_reactions', kind],
          (v = immutable.List()) =>
            v.remove(v.findIndex((r) => r.get('id') === id)),
        )
        .updateIn(
          [activity.id, 'latest_reactions', kind],
          (v = immutable.List()) =>
            v.remove(v.findIndex((r) => r.get('id') === id)),
        );
      return { activities };
    });
  };

  _onToggleReaction = async (
    kind: string,
    activity: BaseActivityResponse,
    options: { trackAnalytics?: boolean } & ReactionRequestOptions<{}> = {},
  ) => {
    let currentReactions = this.state.activities.getIn(
      [activity.id, 'own_reactions', kind],
      immutable.List(),
    );

    if (currentReactions.size) {
      await this._onRemoveReaction(
        kind,
        activity,
        currentReactions.last().get('id'),
        options,
      );
    } else {
      this._onAddReaction(kind, activity, options);
    }
  };

  _doFeedRequest = async (extraOptions) => {
    let options: FeedRequestOptions = {
      withReactionCounts: true,
      withOwnReactions: true,
      ...this.props.options,
      ...extraOptions,
    };

    if (this.props.doFeedRequest) {
      return this.props.doFeedRequest(
        this.props.session,
        this.props.feedGroup,
        this.props.userId,
        options,
      );
    }
    let feed: StreamFeed<{}, {}> = this.props.session.feed(
      this.props.feedGroup,
      this.props.userId,
    );
    return feed.get(options);
  };
  _responseToActivityMap(response) {
    return immutable.fromJS(
      response.results.reduce((map, a) => {
        map[a.id] = a;
        return map;
      }, {}),
    );
  }

  _refresh = async () => {
    await this.setState({ refreshing: true });
    let response = await this._doFeedRequest();

    return this.setState({
      activityOrder: response.results.map((a) => a.id),
      activities: this._responseToActivityMap(response),
      refreshing: false,
      lastResponse: response,
    });
  };

  async componentDidMount() {
    await this._refresh();
  }

  _loadNextPage = async () => {
    let lastResponse = this.state.lastResponse;
    if (!lastResponse || !lastResponse.next) {
      return;
    }
    let cancel = false;
    await this.setState((prevState) => {
      if (prevState.refreshing) {
        cancel = true;
        return {};
      }
      return { refreshing: true };
    });

    if (cancel) {
      return;
    }

    let nextURL = new URL(lastResponse.next, true);
    let response = await this._doFeedRequest(nextURL.query);
    return this.setState((prevState) => {
      let activities = prevState.activities.merge(
        this._responseToActivityMap(response),
      );
      return {
        activityOrder: prevState.activityOrder.concat(
          response.results.map((a) => a.id),
        ),
        activities: activities,
        refreshing: false,
        lastResponse: response,
      };
    });
  };

  _renderWrappedActivity = ({ item }: { item: any }) => {
    return (
      <ImmutableItemWrapper
        renderItem={this._renderActivity}
        item={item}
        navigation={this.props.navigation}
        feedGroup={this.props.feedGroup}
        userId={this.props.userId}
      />
    );
  };

  _childProps = () => ({
    onToggleReaction: this._onToggleReaction,
    onAddReaction: this._onAddReaction,
    onRemoveReaction: this._onRemoveReaction,
    navigation: this.props.navigation,
    feedGroup: this.props.feedGroup,
    userId: this.props.userId,
  });

  _renderActivity = (item: BaseActivityResponse) => {
    let args = {
      activity: item,
      // $FlowFixMe
      styles: this.props.styles.activity,
      ...this._childProps(),
    };

    if (this.props.renderActivity) {
      return this.props.renderActivity(args);
    }

    if (this.props.ActivityComponent) {
      let ActivityComponent = this.props.ActivityComponent;
      return <ActivityComponent {...args} />;
    }

    return null;
  };

  render() {
    let { BelowListComponent } = this.props;
    let styles = buildStylesheet('flatFeed', this.props.styles);

    return (
      <React.Fragment>
        <FlatList
          ListHeaderComponent={this.props.children}
          style={styles.container}
          refreshControl={
            <RefreshControl
              refreshing={this.state.refreshing}
              onRefresh={this._refresh}
            />
          }
          data={this.state.activityOrder.map((id) =>
            this.state.activities.get(id),
          )}
          keyExtractor={(item) => item.get('id')}
          renderItem={this._renderWrappedActivity}
          onEndReached={
            this.props.noPagination ? undefined : this._loadNextPage
          }
        />
        {!BelowListComponent || React.isValidElement(BelowListComponent) ? (
          BelowListComponent
        ) : (
          // $FlowFixMe
          <BelowListComponent {...this._childProps()} />
        )}
      </React.Fragment>
    );
  }
}

type ImmutableItemWrapperProps = {
  renderItem: (item: any) => any,
  item: any,
};

class ImmutableItemWrapper extends React.PureComponent<
  ImmutableItemWrapperProps,
> {
  render() {
    return this.props.renderItem(this.props.item.toJS());
  }
}
