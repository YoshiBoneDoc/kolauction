import SiteFooter from '../components/SiteFooter';

export default function GiveawayInfo() {
    return (
        <div className="site-page-background flex flex-1 flex-col bg-gray-50">
            <main className="mx-auto w-full max-w-3xl flex-1 px-6 pt-12 pb-16">

                <div className="space-y-12 text-sm leading-7 text-gray-700 dark:text-gray-200">

                    {/* INTRODUCTION */}
                    <section className="space-y-6">
                        <div className="inline-block">
                            <h1 className="text-xl font-bold text-blue-600/60 dark:text-blue-300">
                                Seriously, wtf is this?
                            </h1>
                            <div className="mt-2 h-[2px] w-[110%] rounded-full bg-blue-300/60" />
                        </div>

                        <p>
                            I have absolutely no idea.
                        </p>

                        <p>
                            For the next week? Month? Until I get bored?
                            Who knows. For now, there’s going to be a special giveaway auction
                            <em> every day</em>, featuring{' '}
                            <strong>1,000 dense meat stacks</strong> (and
                            potentially other items in the future), with a starting bid of just{' '}
                            <strong>1 Meat</strong>.
                        </p>

                        <p>
                            Each giveaway lasts <strong>exactly one hour</strong>{' '}
                            and starts at a <strong>random time each day</strong>.
                            No advance warning, but our bot will announce it{' '}
                            <em>once</em> in the /trade channel when the auction goes live.
                        </p>
                    </section>

                    {/* RULES */}
                    <section>
                        <div className="mb-5">
                            <div className="inline-block">
                                <h2 className="text-xl font-bold text-gray-900 dark:text-white">
                                    The Rules
                                </h2>
                                <div className="mt-2 h-[2px] w-[110%] rounded-full bg-blue-300/60" />
                            </div>
                        </div>

                        <p className="mb-6">
                            These aren't your ordinary kHub auctions. A few
                            things work differently:
                        </p>

                        <div className="space-y-8">

                            {/* RULE 1 */}
                            <div>
                                <h3 className="mb-2 font-bold text-gray-900 dark:text-white">
                                    1. The Anti Anti-Sniping Rule.{' '}
                                    <span className="font-normal">
                                        (Seriously, who came up with this?)
                                    </span>
                                </h3>

                                <p>
                                    When the hour is up, it's up. The auction
                                    ends at its scheduled time, regardless of
                                    any last-second bids.
                                </p>
                            </div>

                            {/* RULE 2 */}
                            <div>
                                <h3 className="mb-2 font-bold text-gray-900 dark:text-white">
                                    2. No Overbidding.
                                </h3>

                                <p>
                                    You can only bid the next minimum amount,
                                    displayed below the copy-and-paste bot command.
                                    Well, technically you <em>can</em> bid more,
                                    but our bot will just reject it. You may
                                    need to refresh the page to see the latest
                                    minimum bid.
                                </p>
                            </div>

                            {/* RULE 3 */}
                            <div>
                                <h3 className="mb-2 font-bold text-gray-900 dark:text-white">
                                    3. That’s it. Seriously.
                                </h3>

                                <p>
                                    Except for the unnecessary visual chaos.
                                    That’s here to stay. Sorry.
                                </p>
                            </div>

                        </div>
                    </section>

                    {/* FUTURE GIVEAWAYS */}
                    <section>
                        <div className="mb-4">
                            <div className="inline-block">
                                <h2 className="text-xl font-bold text-gray-900 dark:text-white">
                                    The Beginnings of a Tradition?
                                </h2>
                                <div className="mt-2 h-[2px] w-[110%] rounded-full bg-blue-300/60" />
                            </div>
                        </div>

                        <div className="space-y-2">
                            <p>
                                Maybe.
                            </p>

                            <p className="max-w-md">
                                Or maybe I'll wake up tomorrow and wonder why I ever
                                thought this was a good idea.
                            </p>

                            <p className="!mt-10 font-semibold text-gray-900 dark:text-white">
                                Either way, enjoy the chaos.
                            </p>
                        </div>
                    </section>

                </div>
            </main>

            <SiteFooter />
        </div>
    );
}
