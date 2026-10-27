from {{module}} import hello


def test_hello_greets_by_name():
    assert hello("proj") == "hello, proj"
