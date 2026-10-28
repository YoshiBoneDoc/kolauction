import { Link } from 'react-router-dom';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import SiteFooter from '../components/SiteFooter';
import { supabase } from '../lib/supabase';

const photos = [
    {
        label: 'Casual group photo',
        path: 'friends.jpeg',
        alt: 'Three friends together at a gathering.',
        aspect: 'aspect-[768/775]',
        layout: 'is-featured',
    },
    {
        label: 'Graduation photo',
        path: 'grad.png',
        alt: 'A graduate celebrating at a ceremony.',
        aspect: 'aspect-[256/520]',
        layout: 'is-graduation',
    },
    {
        label: 'Operating room photo',
        path: 'or.JPEG',
        alt: 'Two people in an operating room.',
        aspect: 'aspect-[3/4]',
        layout: 'is-operating-room',
    },
    {
        label: 'Waterfront photo',
        path: 'Tbar.png',
        alt: 'A drink overlooking the water.',
        aspect: 'aspect-[3/4]',
        layout: 'is-waterfront',
    },
    {
        label: 'Savannah photo',
        path: 'savannah.jpeg',
        alt: 'Four friends posing outdoors.',
        aspect: 'aspect-[1182/665]',
        layout: 'is-savannah',
    },
    {
        label: 'Yosemite photo',
        path: 'Yosemite.png',
        alt: 'A hiker at a mountain overlook in Yosemite.',
        aspect: 'aspect-[1118/703]',
        layout: 'is-yosemite',
    },
];

function CreatorPhoto({ photo, queue, order }) {
    const container = useRef(null);

    const [image, setImage] = useState({
        status: 'waiting',
        url: null,
    });

    const [visible, setVisible] = useState(false);
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        let disposed = false;
        let objectUrl = null;
        let started = false;

        const controller = new AbortController();

        async function load() {
            if (started) return;

            started = true;

            setImage({
                status: 'loading',
                url: null,
            });

            const previous = queue.current;
            let release;
            queue.current = new Promise(resolve => { release = resolve; });
            await previous;
            try {
                if (disposed) return;
                if (!supabase) {
                    throw new Error('Photo service unavailable.');
                }

                const { data, error } = await supabase.storage
                    .from('creator-photos')
                    .download(
                        photo.path,
                        {},
                        { signal: controller.signal }
                    );

                if (error || !data) {
                    throw new Error('Photo unavailable.');
                }

                if (disposed) return;

                objectUrl = URL.createObjectURL(data);

                setImage({
                    status: 'ready',
                    url: objectUrl,
                });
            } catch {
                if (!disposed) {
                    setImage({
                        status: 'failed',
                        url: null,
                    });
                }
            } finally { release(); }
        }

        const observer =
            typeof IntersectionObserver === 'function'
                ? new IntersectionObserver(
                    entries => {
                        if (
                            entries.some(
                                entry => entry.isIntersecting
                            )
                        ) {
                            observer.disconnect();
                            load();
                        }
                    },
                    { rootMargin: '300px' }
                )
                : null;

        if (observer && container.current) {
            observer.observe(container.current);
        } else {
            load();
        }

        return () => {
            disposed = true;

            observer?.disconnect();
            controller.abort();

            if (objectUrl) {
                URL.revokeObjectURL(objectUrl);
            }
        };
    }, [photo.path, attempt, queue]);

    return (
        <figure
            ref={container}
            className={`creator-collage-photo ${photo.layout || ''}`}
            data-visible={visible}
            style={{ '--photo-delay': `${order * 120}ms` }}
        >
            {image.url ? (
                <div className="creator-photo-reveal">
                    <img
                        onLoad={() => setVisible(true)}
                        src={image.url}
                        alt={photo.alt}
                        className="creator-photo-image"
                    />
                </div>
            ) : (
                <div
                    className={`creator-journal-placeholder flex w-full flex-col items-center justify-center rounded-xl border p-5 text-center ${photo.aspect}`}
                >
                    <span className="text-sm font-semibold text-gray-800">
                        {photo.label}
                    </span>

                    {image.status === 'failed' ? (
                        <>
                            <span className="mt-1 text-xs text-gray-600">
                                Photo could not be loaded.
                            </span>

                            <button
                                type="button"
                                onClick={() =>
                                    setAttempt(value => value + 1)
                                }
                                className="mt-2 min-h-11 text-sm text-blue-700 underline"
                            >
                                Try again
                            </button>
                        </>
                    ) : (
                        <span className="mt-1 text-xs text-gray-600">
                            Loading photo…
                        </span>
                    )}
                </div>
            )}
        </figure>
    );
}

CreatorPhoto.propTypes = {
    queue: PropTypes.shape({ current: PropTypes.object }).isRequired,
    order: PropTypes.number.isRequired,
    photo: PropTypes.shape({
        path: PropTypes.string.isRequired,
        label: PropTypes.string.isRequired,
        alt: PropTypes.string.isRequired,
        aspect: PropTypes.string.isRequired,
        layout: PropTypes.string,
    }).isRequired,
};

export default function MeetTheCreator() {
    const queue = useRef(Promise.resolve());
    useLayoutEffect(() => {
        window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    }, []);

    return (
        <div className="creator-page flex flex-1 flex-col">

            <main className="creator-main mx-auto w-full max-w-[960px] flex-1 px-4 pb-12 pt-7 sm:px-6 sm:pt-10">

                <Link
                    to="/"
                    className="creator-back-link inline-flex min-h-11 items-center text-sm font-medium hover:underline"
                >
                    ← Back to kHub
                </Link>

                <header className="mb-10 mt-3">

                    <p className="creator-eyebrow text-xs font-semibold uppercase tracking-[0.14em]">
                        The person behind kHub
                    </p>

                    <h1 className="mt-2 text-3xl font-bold text-blue-700 sm:text-4xl">
                        Meet the Creator
                    </h1>

                    <p className="mt-4 text-sm font-semibold text-gray-900">
                        Teres Minor{' '}
                        <span className="font-normal text-gray-600">
                            (#3552305)
                        </span>
                    </p>

                    <p className="mt-3 max-w-[750px] text-sm leading-7 text-gray-700 sm:text-[15px]">
                        It’s funny how we can spend years getting to know
                        people online, becoming friends and sharing
                        experiences, yet still know so little about their
                        lives.
                    </p>

                    <p className="mt-3 max-w-[750px] text-sm leading-7 text-gray-700 sm:text-[15px]">
                        Sometimes it’s easy to forget that behind every
                        familiar name is someone with a world of their own
                        that we rarely get to see. Here are a few
                        moments from mine, along with some of the people,
                        places, and experiences that have made it all the
                        more special.
                    </p>

                    <p className="mt-3 max-w-[750px] text-sm leading-7 text-gray-700 sm:text-[15px]">
                        GO DAWGS!
                    </p>

                </header>

                <section
                    aria-label="Photo journal"
                    className="creator-photo-collage"
                >

                    {/* Friends + Graduation */}
                    <div className="creator-collage-row creator-row-top">
                        <CreatorPhoto photo={photos[0]} queue={queue} order={0} />
                        <CreatorPhoto photo={photos[1]} queue={queue} order={1} />
                    </div>

                    {/* Operating Room + Yosemite */}
                    <div className="creator-collage-row creator-row-middle">
                        <CreatorPhoto photo={photos[2]} queue={queue} order={2} />
                        <CreatorPhoto photo={photos[5]} queue={queue} order={3} />
                    </div>

                    {/* Savannah + Tbar */}
                    <div className="creator-collage-row creator-row-bottom">
                        <CreatorPhoto photo={photos[4]} queue={queue} order={4} />
                        <CreatorPhoto photo={photos[3]} queue={queue} order={5} />
                    </div>

                </section>

            </main>

            <SiteFooter />

        </div>
    );
}
