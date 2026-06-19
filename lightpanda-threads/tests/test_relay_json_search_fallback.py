import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "lightpanda_threads_finder.py"
spec = importlib.util.spec_from_file_location("lightpanda_threads_finder", SCRIPT)
finder = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(finder)


def test_relay_json_search_fallback_builds_post_urls_from_threads_search_payload():
    payload = {
        "require": [
            [
                "ScheduledServerJS",
                "handle",
                None,
                [
                    {
                        "__bbox": {
                            "require": [
                                [
                                    "RelayPrefetchedStreamCache",
                                    "next",
                                    [],
                                    [
                                        "adp_BarcelonaSearchResultsQueryRelayPreloader_abc",
                                        {
                                            "__bbox": {
                                                "result": {
                                                    "data": {
                                                        "searchResults": {
                                                            "edges": [
                                                                {
                                                                    "node": {
                                                                        "thread": {
                                                                            "thread_items": [
                                                                                {
                                                                                    "post": {
                                                                                        "user": {"username": "yourboywholovesrotiboy"},
                                                                                        "code": "DZSfvEMkkRV",
                                                                                        "caption": {"text": "area shah alam ada tak rumah sewa"},
                                                                                    }
                                                                                }
                                                                            ]
                                                                        }
                                                                    }
                                                                },
                                                                {
                                                                    "node": {
                                                                        "thread": {
                                                                            "thread_items": [
                                                                                {
                                                                                    "post": {
                                                                                        "user": {"username": "izatikmalik"},
                                                                                        "code": "DZDRzeSgSik",
                                                                                    }
                                                                                }
                                                                            ]
                                                                        }
                                                                    }
                                                                },
                                                            ]
                                                        }
                                                    }
                                                }
                                            }
                                        },
                                    ],
                                ]
                            ]
                        }
                    }
                ],
            ]
        ]
    }

    urls = finder.collect_relay_post_urls(payload, 8)

    assert urls[:2] == [
        "https://www.threads.com/@yourboywholovesrotiboy/post/DZSfvEMkkRV",
        "https://www.threads.com/@izatikmalik/post/DZDRzeSgSik",
    ]


def test_relay_json_text_filter_accepts_search_preloader_only():
    search_json = (
        '{"require":[["RelayPrefetchedStreamCache","next",[],["adp_BarcelonaSearchResultsQueryRelayPreloader_x",'
        '{"result":{"data":{"searchResults":{"edges":[{"node":{"thread":{"thread_items":[{"post":{"user":{"username":"syuhadanadyra"},"code":"DZhgnMAk7_d"}}]}}}]}}}}]]]}'
    )
    unrelated_json = '{"require":[["Other","noop",[],[{"post":{"user":{"username":"ignored"},"code":"IGNOREME"}}]]]}'

    urls = finder.extract_relay_post_urls_from_json_texts([unrelated_json, search_json], 8)

    assert urls == ["https://www.threads.com/@syuhadanadyra/post/DZhgnMAk7_d"]
